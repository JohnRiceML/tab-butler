import { CONFIG } from "../lib/config";
import { REPLY_ANGLES } from "../lib/prompts";
import { parseTimelineTweets, parseUser, pickDiscoveryTweets, pickOwnPostsWithStats, nicheSearchQuery, freshReachExplorationQueries, nicheTopics, type OwnPost, type TwttrTweet } from "../lib/twttr";
import { computeMomentum, dailyShape } from "../lib/momentum";
import { activityCells, chain, pickCallout } from "../lib/activity";
import { profileCheck, analyzeBio, type ProfileState } from "../lib/profile-check";
import { aggregateAccounts, rankAccounts, concentration, cadenceTrend, foldOwnDelta, matchOutcomes, accountTrend, learnFeatures, accountRankMultipliers, fillAuthorReplied, isConfirmedReply, replyVerificationSummary, mergeReplyOutcomes, GLOBAL_THIN, type PostMetrics, type DailyDelta, type FetchedReply } from "../lib/learn-stats";
import { aggregateSupporters, rankSupporters, fuseMutual, cadence as supCadence, reciprocalConcentration, GLOBAL_THIN as SUP_GLOBAL_THIN, type EngagedRecord, type EngagedKind, type Rel } from "../lib/supporters";
import { ideaTokens, jaccard, TOO_SIMILAR, INPUT_DEDUP, COPY_LEAK, copyLeak, isEnglish, isBait, looksLikeRT, classifyShape, scoreWinner, percentile, bandFor, isBreakout, calibrateRates, setRateTable, shapePerformance, type Band, type Shape } from "../lib/idea-quality";
import { reconcileIdeaPublications, type IdeaPublication } from "../lib/idea-outcomes";
import { nextShipSlots, reminderState, formatSlot, reminderToastLine } from "../lib/schedule";
import { freshStore, addTarget, removeTarget, excludeFromTargets, inReachBand, reachMultipleLabel, freshnessLabel, earlyLabel, bandHiFor, selectPollBatch, slotOdds, TARGET_POLL_TTL_MS, type TargetStore } from "../lib/targets";
import { rankThreads, TEND_WINDOW_MS, type InboundLite } from "../lib/threads";
import { AUTHOR_REACH_TTL_MS, HEAVY_HITTER_TTL_MS } from "../lib/twttr-policy";
import { rankSuggestions, suggestionReason, type SuggestionInput } from "../lib/suggest-targets";
import { isDuplicateReply, normalizeReply, pickReplyNudge, replyPaceStatus, replyQualityWarning, REPLY_PACE_EASEOFF, type ReplyPaceEvent, type ReplyPaceStatus } from "../lib/reply-hygiene";
import { humanDelayMs, jitterGap } from "../lib/human-pacing";
import { mountGoobi, type GoobiMood, type GoobiHandle } from "../lib/goobi";
import { builderTier } from "../lib/community";
import { freshOpportunityMetricStore, observeMany, momentumFor, applyMomentum, adjustedTargetTime, mergeOpportunityMetricStores, pruneStore as pruneOpportunityMetrics, type OpportunityMetricStore } from "../lib/opportunity-momentum";
import { connectionEvidence, foldCompletedExchanges, freshRelationshipMemory, mergeRelationshipMemory, pruneRelationshipMemory, type RelationshipMemoryStore } from "../lib/relationship-memory";
import { recommendReply, repeatAuthorWarning, replyFreshness, type ReplyRecommendation } from "../lib/reply-recommendation";
import { FRESH_REACH_ACCOUNT_CHECKS, FRESH_REACH_MAX_AGE_MS, FRESH_REACH_WATCHLIST_MAX, decayFreshReachEvidence, freshReachCandidate, freshReachContentEligible, freshReachOpeningBand, freshReachOpeningScore, freshReachPostSignals, freshReachShortlist, isMassiveFreshReachAccount, pickFreshReachAccounts, pickFreshReachCandidates, type FreshReachAccount, type FreshReachOpportunityKind, type FreshReachShortlistAccount } from "../lib/fresh-reach";
import { handoffMatchesPath, isReplyBubblePath, statusIdFromPath, validReplyHandoff, type ReplyHandoff } from "../lib/reply-handoff";
import { GROWTH_STRATEGIES, GROWTH_WINDOW_DAYS, activeGrowthExperiment, captureGrowthSnapshot, evaluateGrowthExperiment, finishGrowthExperiment, freshGrowthStore, growthStrategy, mergeGrowthStores, recommendedGrowthStrategy, seedFollowerSnapshot, settleGrowthExperiments, startGrowthExperiment, summarizeGrowthWindow, type GrowthExperiment, type GrowthStore, type GrowthStrategyId, type TaggedGrowthAction } from "../lib/growth-loop";
import { DM_INTENT_LABEL, DM_STAGE_LABEL, addDmCandidate, appendDmContext, canDraftDm, canMarkDmSend, canMoveDmReady, dmPacingStatus, dueFollowUps, findDmDuplicate, followUpCount, freshDmStore, markDmReplied, markDmSent, mergeDmStores, pruneDmStore, rankDmSuggestions, redactDmTouch, removeDmCandidate, removeDmContext, sortDmCandidates, updateDmCandidate, type DmCandidate, type DmContextKind, type DmIntent, type DmPhase, type DmStore, type DmSuggestionInput } from "../lib/dm-workspace";
import { candidateDmSignal, deriveDmMetrics, rankDmNextActions } from "../lib/dm-intelligence";
import { DEFAULT_DAILY_GOALS, dailyGoalPercent, normalizeDailyGoals, type DailyGoals } from "../lib/daily-goals";
import type { Message, ProductItem } from "../lib/types";

/**
 * Goobi — X (Twitter) reply copilot. Runs only on x.com/twitter.com.
 * Scans timeline posts, asks the SW (Claude) to score reply-worthiness, badges
 * the worthwhile ones, and drafts a reply in the user's voice on demand.
 * DRAFT ONLY — never posts. Hardened (per adversarial review) for X's
 * virtualized timeline: dedup by status id, skip ads/own posts, re-badge from
 * cache on remount, rAF-coalesced scanning, a per-session call cap.
 */

const ACCENT = "#d69a5c";
const INK = "#1a1206";
const DONE = "#3aa564", DONE_INK = "#06210f"; // green "✓ commented" call-out on posts you've replied to
const THRESHOLD = 0.6;
const MAX_SCORE_CALLS = 40; // per page-session cost/ToS guard
const BATCH = 12;

let scoreCalls = 0;
let enabled = true;
let paused = false; // temporary "take a break" — halts scanning/surfacing/API until resumed
let selfHandle = "";
let noKeyNotified = false;
let scanCapNotified = false; // surface the per-session scan cap once, instead of silently stopping

/** The user's products (relevance-tagged promotion) + legacy single-product fallback.
 *  Read from storage on boot and kept fresh via storage.onChanged. */
let xProducts: ProductItem[] = [];
let legacyProduct = "";
let xDefaultAngle = "";   // "" = use the scorer's per-post category; else a REPLY_ANGLES id
let xDefaultProduct = ""; // "" = best-fit; else a product name to prefer when promoting
let xReplyInsertOn = false; // default off: exact-post X handoff + manual review; true preserves an explicit legacy opt-in
let learnLoopOn = false;  // close-the-loop kill switch: MEASURED outcomes influence ranking + the drafter's default angle. Default OFF until a real-data backtest validates the signal; even ON, learn-stats' own gates (fitCorr n>=12, bestAngle rel>=1.15, neutral-on-absent) keep it inert on thin data.
let debugOn = false;      // dev-only: exposes window.__goobiExport() for backtesting. No product effect.

/** Twttr (X-data API) enrichment, all read-only + best-effort. */
let xNiche = "";              // the niche query "Find spots" searches X for
let premiumTier = "";         // "", "free", "premium", "premium+" — an honest covariate, never a score input
let dailyGoals: DailyGoals = DEFAULT_DAILY_GOALS;
let profileState: ProfileState | undefined; // own-profile harvest (pinned id + bio length), $0
let myFollowers = 0;          // the user's own follower count, for the reach sweet-spot
let twttrUnconfigured = false; // once the SW reports no key/host, stop trying until settings change
let growthStore: GrowthStore = freshGrowthStore(""); // account-level strategy experiments + outcome windows

/** product host -> favicon data URL ("" = known no-favicon). Resolved by the SW
 *  from Chrome's built-in `_favicon` cache (no network, no CORS) and inlined as a
 *  data URL, since x.com's CSP blocks a direct external/extension favicon <img>. */
const faviconCache = new Map<string, string>();
function faviconHost(url?: string): string | undefined {
  if (!url) return undefined;
  try { return new URL(url.startsWith("http") ? url : `https://${url}`).hostname; } catch { return undefined; }
}
function faviconImg(url?: string): HTMLImageElement | undefined {
  const host = faviconHost(url);
  const data = host ? faviconCache.get(host) : undefined;
  if (!data) return undefined; // undefined (not fetched) or "" (no favicon) -> caller uses the letter chip
  const im = document.createElement("img"); im.className = "pfav"; im.src = data; im.alt = ""; im.onerror = () => im.remove();
  return im;
}
async function loadFavicons(): Promise<void> {
  const hosts = [...new Set(xProducts.map((p) => faviconHost(p.url)).filter((h): h is string => !!h && !faviconCache.has(h)))];
  if (!hosts.length) return;
  const resp = await send<{ favicons?: Record<string, string> }>({ type: "GET_FAVICONS", hosts });
  if (invalidated || !contextOK()) return; // context may have died during the await
  let any = false;
  for (const [h, d] of Object.entries(resp?.favicons || {})) { faviconCache.set(h, d); if (d) any = true; } // cache "" too (known miss)
  if (any) renderDock(); // upgrade the letter chips to the real favicon once it resolves
}

/** A colored letter chip standing in for a product when Chrome has no cached
 *  favicon for its site. Deterministic per name, needs no network or permission. */
function letterAvatar(name: string): HTMLElement {
  const s = document.createElement("span"); s.className = "pini";
  s.textContent = (name.trim()[0] || "·").toUpperCase();
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  s.style.background = `hsl(${h % 360} 55% 42%)`; // deterministic per product name
  return s;
}

/** The user's measured-best drafting angle, when the loop is on. Reads bestAngle, which
 *  learn-stats sets ONLY when the top angle clears the +15% band over >=2 angles — so it's
 *  inert on thin/ambiguous data. Caveat: this is a USER-level tendency, not post-specific, so
 *  it ships behind the flag + the T1 (angle-stability) gate and stays a SOFT default. */
function learnedBestAngle(): string | undefined {
  return learnLoopOn ? learnFeatures(replyLog.sent, Date.now()).bestAngle : undefined;
}
/** The angle a draft should open with: the user's explicit default, else their measured-best
 *  angle (loop on), else the scorer's per-post pick. Steer chips still override per-click. */
function initialAngle(category?: string): string | undefined { return xDefaultAngle || learnedBestAngle() || category; }
/** Which product to preselect among candidates: the user's default if present, else the first. */
function defaultProductIndex(candidates: ProductItem[]): number {
  if (!xDefaultProduct) return 0;
  const i = candidates.findIndex((p) => p.name === xDefaultProduct);
  return i >= 0 ? i : 0;
}

/** The product context string sent to the drafter: the (snapshotted) tagged
 *  product for a promote opp, else all current products (the drafter picks if a
 *  post invites it), else the legacy single-product fallback. */
function productContext(product?: ProductItem): string | undefined {
  const fmt = (p: ProductItem) => `${p.name}${p.blurb ? ` — ${p.blurb}` : ""}${p.url ? ` (${p.url})` : ""}`;
  if (product) return fmt(product);
  if (xProducts.length) return xProducts.map(fmt).join("\n");
  return legacyProduct.trim() || undefined;
}

type ReplyMove = "add_detail" | "counterpoint" | "concrete_example" | "narrow_question" | "substantive_support";
type ReplyRisk = "none" | "generic" | "promotional" | "context_mismatch" | "hostile";
interface ScoredPost { i: number; score: number; reason: string; category?: string; products?: string[]; anchor?: string; replyMove?: ReplyMove; replyBrief?: string; risk?: ReplyRisk; }
interface FreshReachEvidence {
  runId: string; discoveredAt: number; observedAt: number; expiresAt: number;
  repliesObserved: number; sizeMultiple: number;
  accountSource: "watchlist" | "tracked" | "heavy-hitter" | "latest";
  accountPriority: number; observedOpportunity: number; contentFit: number;
  kind: FreshReachOpportunityKind;
  viewsObserved?: number; engagementsObserved?: number;
  viewsPerMinute?: number; engagementsPerMinute?: number;
  distributionScore: number;
  openingScore?: number;
}
interface HeavyHitterEntry {
  followers: number; engRate: number; n: number; at?: number;
  distributionScore?: number; viewRate?: number;
  peakViews?: number; peakEngagements?: number;
  discoveredAt?: number; lastSeenAt?: number; lastCheckedAt?: number;
  checks?: number; strongOpenings?: number; latestPostId?: string;
  openingPostIds?: string[];
  shortlisted?: boolean; replyViewOutcomes?: number; replyViewScore?: number; bestReplyViews?: number; shortlistAt?: number;
  source?: "top" | "latest";
}
interface HeavyHitterStore { niche?: string; entries?: Record<string, HeavyHitterEntry>; }
interface FreshReachWatchEntry {
  handle: string; followers: number; addedAt: number;
  lastCheckedAt?: number; checks?: number; strongOpenings?: number; openingPostIds?: string[];
}
interface FreshReachWatchStore { ownerHandle: string; entries: FreshReachWatchEntry[]; }

/** status id -> last result. Authoritative dedup + instant re-badge on remount. */
const seen = new Map<string, { score: number; reason: string; category?: string; products?: ProductItem[]; anchor?: string; replyMove?: ReplyMove; replyBrief?: string; risk?: ReplyRisk; isReplyToOwnPost?: boolean }>();

/** Collected reply-worthy posts, surfaced in the always-on dock. */
interface Opp { id: string; author: string; text: string; score: number; reason: string; context?: string; postedAt?: number; likes?: number; replies?: number; views?: number; reposts?: number; quotes?: number; avatar?: string; category?: string; products?: ProductItem[]; name?: string; followers?: number; source?: "feed" | "search" | "target" | "fresh-reach"; freshReach?: FreshReachEvidence; anchor?: string; replyMove?: ReplyMove; replyBrief?: string; risk?: ReplyRisk; verified?: boolean; manual?: boolean; isReplyToOwnPost?: boolean; }
const opps = new Map<string, Opp>();
let opportunityMetrics: OpportunityMetricStore = freshOpportunityMetricStore();
function observeOpportunityTweets(posts: Array<{ id: string; postedAt?: number; likes?: number; replies?: number; reposts?: number; views?: number }>): void {
  const next = observeMany(opportunityMetrics, posts, Date.now());
  opportunityMetrics = next.store;
  if (next.changed) safeSet({ [CONFIG.X_OPPORTUNITY_METRICS_KEY]: opportunityMetrics });
}
function opportunityMomentum(id: string, now = Date.now()) { return momentumFor(opportunityMetrics.tracks[id], now); }
let dockOpen = false;
let dockFilter = "";
const expandedReplyCards = new Set<string>(); // one reply card at a time exposes evidence + secondary actions

interface Queued { id: string; author: string; text: string; context?: string; el: HTMLElement; isReplyToOwnPost: boolean; }
const queue: Queued[] = [];
/** Posts sent to Claude and awaiting a score — guards against re-queueing the
 *  same post during the request window (e.g. a Rescan mid-flight). */
const inFlight = new Set<string>();

function getLocal(key: string): Promise<unknown> {
  return new Promise((res) => {
    try { chrome.storage.local.get(key, (o) => res(chrome.runtime.lastError ? undefined : o[key])); }
    catch { res(undefined); } // context died mid-call
  });
}
/** chrome.storage.local.set THROWS SYNCHRONOUSLY once the context is invalidated — before
 *  it returns a promise — so a trailing `.catch()` never attaches and the error escapes.
 *  Gate on the live context + wrap, so every persist is best-effort and never uncaught. */
function safeSet(obj: Record<string, unknown>): void {
  if (invalidated || !contextOK()) return;
  try { void chrome.storage.local.set(obj).catch(() => { /* best-effort */ }); } catch { /* context died mid-call */ }
}
function send<T>(msg: unknown): Promise<T | undefined> {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? undefined : (r as T)));
    } catch {
      res(undefined);
    }
  });
}

/** The extension context dies when the unpacked extension is reloaded/updated while
 *  a page stays open — the old content script keeps running but chrome.* is gone, so
 *  the next call throws "Extension context invalidated". Detect it and shut down
 *  cleanly (stop the loops, drop the UI) instead of spewing uncaught errors. */
let invalidated = false;
let bodyObs: MutationObserver | null = null;
let urlPoll: ReturnType<typeof setInterval> | undefined;
let remindPoll: ReturnType<typeof setInterval> | undefined; // draft-and-remind due-watcher (30s, no network)
let pacePoll: ReturnType<typeof setInterval> | undefined; // local adaptive pace decay; no network
function contextOK(): boolean { try { return !!chrome.runtime?.id; } catch { return false; } }
function teardown(): void {
  if (invalidated) return;
  invalidated = true;
  try { bodyObs?.disconnect(); } catch { /* ignore */ }
  if (urlPoll) clearInterval(urlPoll);
  if (remindPoll) clearInterval(remindPoll);
  if (pacePoll) clearInterval(pacePoll);
  if (flushTimer) clearTimeout(flushTimer);
  try { resetPlay(); } catch { /* ignore */ } // destroy the big Goobi + cancel in-flight treats
  try { stopIdeasGoobi(); } catch { /* ignore */ }
  try { dockHost?.remove(); } catch { /* ignore */ } // detaching the dock stops Goobi's loops (they self-guard on isConnected)
  try { dismissPanel(true); } catch { /* ignore */ }
}

/** Belt-and-suspenders for the orphaned-content-script race: when the extension is reloaded while
 *  x.com stays open, the old script can throw "Extension context invalidated" from an ASYNC
 *  continuation (a pending sendMessage/storage callback, a timer, an image load) that the per-call
 *  guards can't wrap. Catch it globally, shut down quietly once, and swallow it so it never surfaces
 *  as an uncaught console error. */
function isCtxInvalidated(e: unknown): boolean {
  const msg = (e as { message?: string } | null)?.message ?? String(e ?? "");
  return /context invalidated|extension context/i.test(msg);
}
window.addEventListener("error", (ev) => { if (isCtxInvalidated(ev.error) || isCtxInvalidated(ev.message)) { teardown(); ev.preventDefault(); } }, true);
window.addEventListener("unhandledrejection", (ev) => { if (isCtxInvalidated(ev.reason)) { teardown(); ev.preventDefault(); } });

/* ---------- X DOM extraction (resilient to quote-tweets / virtualization) ---------- */

function statusInfo(el: HTMLElement): { id: string; author: string } | null {
  // The article's canonical permalink is the anchor wrapping its <time>.
  const a =
    (el.querySelector('a[href*="/status/"] time')?.closest("a") as HTMLAnchorElement | null) ||
    el.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  const m = (a?.getAttribute("href") || "").match(/^\/([^/]+)\/status\/(\d+)/);
  return m ? { author: m[1], id: m[2] } : null;
}

/** Outer post text — not the nested quoted tweet (which lives in a role=link). */
function outerText(el: HTMLElement): string {
  const texts = Array.from(el.querySelectorAll('[data-testid="tweetText"]'));
  const outer = texts.find((t) => !t.closest('[role="link"]')) || texts[0];
  return outer?.textContent?.trim() || "";
}
function quotedText(el: HTMLElement): string | undefined {
  const q = Array.from(el.querySelectorAll('[data-testid="tweetText"]')).find((t) => t.closest('[role="link"]'));
  return q?.textContent?.trim() || undefined;
}
function isPromoted(el: HTMLElement): boolean {
  if (el.closest('[data-testid="placementTracking"]')) return true;
  return Array.from(el.querySelectorAll("span")).some((s) => {
    const t = s.textContent?.trim();
    return t === "Promoted" || t === "Ad";
  });
}
function getSelf(): string {
  const a = document.querySelector<HTMLAnchorElement>('[data-testid="AppTabBar_Profile_Link"]');
  return (a?.getAttribute("href") || "").replace(/^\//, "").toLowerCase();
}

/** Whether X explicitly renders this outer post as "Replying to @me". This is deliberately
 * structural and conservative: an @mention inside the tweet body or author header must never be
 * mistaken for a comment on the user's post. X does not expose the parent status id in feed DOM,
 * so the visible reply-context row is the strongest honest signal available without an API call. */
function isReplyToOwnPost(el: HTMLElement, handle = selfHandle || getSelf()): boolean {
  const self = handle.replace(/^@+/, "").toLowerCase();
  if (!self) return false;
  const ownPath = `/${self}`;
  const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((a) => {
    const path = (a.getAttribute("href") || "").split(/[?#]/, 1)[0].replace(/\/$/, "").toLowerCase();
    return path === ownPath && !a.closest('[data-testid="User-Name"], [data-testid="tweetText"], [data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container"]');
  });
  for (const link of links) {
    let node: HTMLElement | null = link.parentElement;
    for (let depth = 0; node && node !== el && depth < 5; depth++, node = node.parentElement) {
      const label = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (label.length <= 160 && /\breplying to\b/i.test(label)) return true;
    }
  }
  return false;
}

/** The OUTER author's display name (not the @handle) — skip the quoted tweet's. */
function displayName(el: HTMLElement): string | undefined {
  const un = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="User-Name"]')).find((n) => !n.closest('[role="link"]'));
  if (!un) return undefined;
  // User-Name text is "Display Name@handle·time"; the name is everything before the @handle.
  const name = (un.textContent || "").split("@")[0].replace(/[·•].*$/s, "").replace(/​/g, "").trim();
  return name || undefined;
}

/** Whether the OUTER author shows a verified badge (best-effort; no badge if unsure). */
function isVerified(el: HTMLElement): boolean {
  const un = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="User-Name"]')).find((n) => !n.closest('[role="link"]'));
  return !!un?.querySelector('[data-testid="icon-verified"], svg[aria-label="Verified account"]');
}

/** The OUTER author's avatar URL — skip the quoted tweet's avatar (role=link). */
function avatarUrl(el: HTMLElement): string | undefined {
  const cs = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container"]'));
  const c = cs.find((n) => !n.closest('[role="link"]')) || cs[0];
  if (!c) return undefined;
  const src = c.querySelector<HTMLImageElement>("img")?.getAttribute("src");
  if (src?.startsWith("http")) return src;
  for (const n of c.querySelectorAll<HTMLElement>("[style*='background-image']")) {
    const m = n.style.backgroundImage.match(/url\("?(https?:[^")]+)"?\)/);
    if (m) return m[1];
  }
  return undefined;
}

/* ---------- post stats: freshness + engagement ---------- */

/** Exact post time (epoch ms) from the article's <time datetime>. Prefers the
 *  OUTER post's time, not a nested quoted tweet's (role=link) — mirrors
 *  outerText()/quotedText() so quote-tweets report their own age, not the quote's. */
function postedAtMs(el: HTMLElement): number | undefined {
  const times = Array.from(el.querySelectorAll<HTMLElement>('a[href*="/status/"] time'));
  const t = times.find((n) => !n.closest('[role="link"]')) || times[0];
  const dt = t?.getAttribute("datetime");
  const ts = dt ? Date.parse(dt) : NaN;
  return Number.isNaN(ts) ? undefined : ts;
}

/** "1.2K" / "3,400" / "2 345" / "2M" -> integer. Rejects malformed (.1, 1.2.3). */
function parseCount(s: string): number | undefined {
  const m = s.replace(/[,\s]/g, "").match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (!m) return undefined;
  const base = parseFloat(m[1]);
  if (!Number.isFinite(base)) return undefined;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] ?? 1;
  return Math.round(base * mult);
}

interface PostStats { postedAt?: number; likes?: number; replies?: number; reposts?: number; views?: number; }

/** Engagement counts. The action-bar's aria-label carries EXACT totals
 *  ("45 replies, 12 reposts, 678 likes, 9,001 views"); fall back to the
 *  abbreviated per-button text ("1.2K") when the label is absent. */
function engagement(el: HTMLElement): PostStats {
  // Resolve the OUTER post's action bar, not a nested quoted tweet's (role=link);
  // scope the button fallbacks to that same bar so quote-tweets don't bleed.
  const groups = Array.from(el.querySelectorAll<HTMLElement>('[role="group"][aria-label]'));
  const group = groups.find((g) => !g.closest('[role="link"]')) || groups[0] || null;
  const scope = group || el;
  const label = group?.getAttribute("aria-label") || "";
  // Letters in the label act as firewalls, so the count token captured before
  // each keyword is just that metric's number; parseCount strips any leading
  // separators and honors a K/M/B suffix if X ever abbreviates in the label.
  const fromLabel = (re: RegExp): number | undefined => {
    const m = label.match(re);
    return m ? parseCount(m[1]) : undefined;
  };
  const fromButton = (testid: string): number | undefined => {
    const txt = scope.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.textContent?.trim();
    return txt ? parseCount(txt) : undefined;
  };
  return {
    replies: fromLabel(/([\d.,\s]*\d[KMB]?)\s*(?:repl|comment)/i) ?? fromButton("reply"),
    reposts: fromLabel(/([\d.,\s]*\d[KMB]?)\s*(?:repost|retweet)/i) ?? fromButton("retweet"),
    likes: fromLabel(/([\d.,\s]*\d[KMB]?)\s*likes?\b/i) ?? fromButton("like") ?? fromButton("unlike"),
    views: fromLabel(/([\d.,\s]*\d[KMB]?)\s*views?\b/i),
  };
}

/** Snapshot a post's stats at capture time (counts can't be re-read once X
 *  recycles the node; the timestamp is absolute so age stays accurate).
 *  NOTE: when the virtualized timeline RE-RENDERS a seen post, scan()'s cached
 *  branch refreshes the opp's likes/replies from the live node — so counts are
 *  frozen only while a post stays off-screen, not forever. */
function snapStats(el: HTMLElement): PostStats {
  if (!el.isConnected) return {};
  return { postedAt: postedAtMs(el), ...engagement(el) };
}

/** "now" | "5m" | "3h" | "2d" | "4w" | "6mo" from an epoch-ms timestamp. */
function fmtAge(ms?: number): string | undefined {
  if (!ms) return undefined;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  const d = Math.round(h / 24); if (d < 7) return `${d}d`;
  const w = Math.round(d / 7); if (w < 5) return `${w}w`;
  return `${Math.round(d / 30)}mo`;
}

/** 1234 -> "1.2k", 1200000 -> "1.2m". */
function fmtCount(n?: number): string | undefined {
  if (n === undefined) return undefined;
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`.replace(".0k", "k");
  return `${(n / 1e6).toFixed(1)}m`.replace(".0m", "m");
}

/* ---------- scan / score ---------- */

let scanPending = false;
function requestScan() {
  if (invalidated || !contextOK()) { teardown(); return; } // extension reloaded out from under us
  if (scanPending || !enabled) return;
  scanPending = true;
  requestAnimationFrame(() => { scanPending = false; scan(); });
}

/** Harvest the profile CONVERSION surface from the user's own profile page ($0, DOM-only):
 *  the pinned post's status id + the bio length. Guards against false claims — only harvests
 *  when the profile header has rendered AND the timeline shows enough articles that a missing
 *  "Pinned" label genuinely means no pinned post (never claims "no pin" off a half-loaded page). */
let profileHarvestAt = 0;
function harvestOwnProfile(): void {
  if (Date.now() - profileHarvestAt < 30_000) return; // settle window — the route re-scans constantly
  if (!document.querySelector('[data-testid="UserName"]')) return; // header not rendered yet

  // Conversion-surface signals from the already-rendered header (available even for a thin timeline).
  // analyzeBio runs HERE so only the booleans are stored — the bio text never leaves the page.
  const bioEl = document.querySelector('[data-testid="UserDescription"]');
  const bioText = (bioEl?.textContent || "").trim(); // X omits the element entirely for an empty bio
  const ba = bioText ? analyzeBio(bioText) : undefined;
  let nameDescriptive: boolean | undefined;
  const unText = document.querySelector('[data-testid="UserName"]')?.textContent || "";
  if (unText && selfHandle) {
    const hi = unText.indexOf("@" + selfHandle);
    const namePart = (hi >= 0 ? unText.slice(0, hi) : unText).trim(); // the display name sits before the @handle
    const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const hasSep = /[·|—–]/.test(namePart) || namePart.split(/\s+/).filter(Boolean).length >= 2; // a real name / descriptor
    nameDescriptive = namePart.length > 0 && (hasSep || norm(namePart) !== norm(selfHandle));
  }
  // Banner: X links a set banner to /header_photo and serves it from /profile_banners/; an unset
  // banner is a plain colored div with neither. (A rare miss → a mild, low-harm nag.)
  const hasBanner = !!document.querySelector('a[href$="/header_photo"]') || !!document.querySelector('img[src*="profile_banners"]');
  const extras = { bioLen: bioText.length, bioHasRole: ba?.hasRole, bioHasAudience: ba?.hasAudience, bioHasProof: ba?.hasProof, bioHasPromise: ba?.hasPromise, nameDescriptive, hasBanner };

  const articles = document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]');
  if (articles.length < 3) {
    // Timeline too thin to trust pin detection (tiny account / still loading) — leave the pin fields
    // untouched, but the header signals above are valid regardless.
    profileState = { ...(profileState ?? { at: 0 }), ...extras, ownerHandle: selfHandle, at: Date.now() };
    safeSet({ [CONFIG.X_PROFILE_KEY]: profileState });
    profileHarvestAt = Date.now();
    return;
  }
  profileHarvestAt = Date.now();
  let pinnedId: string | undefined;
  for (const el of articles) {
    const sc = el.querySelector('[data-testid="socialContext"]');
    if (sc && /pinned/i.test(sc.textContent || "")) { pinnedId = statusInfo(el)?.id; break; }
  }
  // A MISSING "Pinned" label is only trustworthy on an English UI — on "Épinglé"/"固定された"
  // the regex never matches and a false "no pinned post" claim would break the honest mirror.
  // A FOUND pin is trustworthy in any case (the regex matched).
  const pinKnown = pinnedId != null || (document.documentElement.lang || "").toLowerCase().startsWith("en");
  profileState = { ...(profileState ?? { at: 0 }), ...extras, ownerHandle: selfHandle, pinnedId, pinKnown, at: Date.now() };
  safeSet({ [CONFIG.X_PROFILE_KEY]: profileState });
}

/** Manual-scan override window: an explicit ⟳ Rescan lets one pass run even at ease-off. */
let manualScanUntil = 0;
function scan() {
  if (!enabled || paused) return;
  // On the notifications route, harvest who engaged with ME instead of scoring posts to reply to.
  if (location.pathname.startsWith("/notifications")) { scanNotifications(); return; }
  // On the user's OWN profile, harvest the conversion surface (pinned post + bio) at $0. No return —
  // the normal scan continues (own posts are skipped by the self check anyway).
  if (selfHandle && location.pathname.toLowerCase() === "/" + selfHandle) harvestOwnProfile();
  // Ease-off = STOP analyzing too. Past the pace line the ambient scan pauses (no new queueing,
  // no Haiku spend) — surfacing more reply spots while the user should be cooling down is the
  // opposite of the honest mirror. Manual actions still work: ⟳ Rescan opens a short window,
  // and Find spots doesn't route through here at all. The pace chip/momentum strip show why.
  if (currentReplyPace().level === "easeoff" && Date.now() > manualScanUntil) return;
  if (scoreCalls >= MAX_SCORE_CALLS) {
    if (!scanCapNotified) { scanCapNotified = true; toast("Scanned a lot this session — hit ⟳ Rescan in the dock to keep finding spots."); }
    return;
  }
  if (!selfHandle) selfHandle = getSelf();
  document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]').forEach((el) => {
    const info = statusInfo(el);
    if (!info) return;
    if (inFlight.has(info.id)) return; // sent to Claude, awaiting its score
    const cached = seen.get(info.id);
    if (cached) {
      const o = opps.get(info.id);
      // X sometimes paints the lightweight reply-context row after the tweet text. Upgrade a
      // cached item as soon as that evidence appears so virtualization cannot freeze a cold read.
      if (!cached.isReplyToOwnPost && isReplyToOwnPost(el)) {
        cached.isReplyToOwnPost = true;
        if (o) o.isReplyToOwnPost = true;
      }
      if (commentedIds.has(info.id)) badge(el, cached.reason, cached.category, o ? effectiveScore(o) : cached.score); // replied → green badge, not in the dock
      else if (o) {
        // Surfaced — refresh counts from the LIVE node X just re-rendered, so pileup/buried and the
        // likes-reach fallback track the thread as it GROWS (freshness already recomputes live;
        // frozen counts were the one stale term — a post that blew up after queueing kept ranking
        // as an easy fresh reply). Zero API calls, no stored DOM refs: only nodes the virtualized
        // timeline has put back on screen. Off-screen opps still refresh the next time you scroll by.
        const live = engagement(el);
        if (live.likes != null) o.likes = live.likes;
        if (live.replies != null) o.replies = live.replies;
        if (live.views != null) o.views = live.views;
        if (live.reposts != null) o.reposts = live.reposts;
        badge(el, o.reason, o.category, effectiveScore(o)); // surfaced (auto-scored or manually added)
      }
      else addButton(el); // scored but didn't make the cut → offer a manual "+ Add"
      return;
    }
    if (el.dataset.tbx === "q") return; // this node already queued
    if (isPromoted(el)) return;
    if (selfHandle && info.author.toLowerCase() === selfHandle) return;
    const text = outerText(el);
    if (!text) return; // media-only / not painted yet — re-evaluated next pass
    el.dataset.tbx = "q";
    queue.push({
      id: info.id,
      author: info.author,
      text: text.slice(0, 400),
      context: quotedText(el)?.slice(0, 320),
      el,
      isReplyToOwnPost: isReplyToOwnPost(el),
    });
  });
  scheduleFlush();
}

let flushTimer: number | undefined;
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 900) as unknown as number;
}

async function flush() {
  if (invalidated || !contextOK()) { teardown(); return; }
  if (!enabled || paused || scoreCalls >= MAX_SCORE_CALLS) return;
  const batch = queue.splice(0, BATCH).filter((q) => q.el.isConnected && !seen.has(q.id));
  if (!batch.length) return;
  scoreCalls++;
  const snap = batch.map((b) => ({ ...snapStats(b.el), avatar: b.el.isConnected ? avatarUrl(b.el) : undefined, name: b.el.isConnected ? displayName(b.el) : undefined, verified: b.el.isConnected ? isVerified(b.el) : undefined }));
  const posts = batch.map((b, i) => ({
    i, author: b.author, text: b.text, context: b.context,
    // This observed relationship belongs in content-fit scoring: it distinguishes warm inbound
    // conversation from a cold reply spot. Timing + reach still remain live local signals.
    meta: b.isReplyToOwnPost ? "DIRECT COMMENT ON THE USER'S OWN POST" : undefined,
  }));
  batch.forEach((b) => inFlight.add(b.id));
  refreshGoobi(); // Goobi concentrates while Claude analyzes the batch
  const resp = await send<{ scores?: ScoredPost[]; error?: string }>({
    type: "SCORE_POSTS",
    posts,
  });
  batch.forEach((b) => inFlight.delete(b.id));
  refreshGoobi();
  if (resp?.error === "no-key") {
    if (!noKeyNotified) { noKeyNotified = true; toast("Add your Anthropic key in the Goobi panel to enable reply suggestions."); }
    enabled = false; // stop hammering until reload
    return;
  }
  if (!resp || resp.error) return; // transient error — back off; the cap bounds retries
  let changed = false;
  for (const s of resp.scores ?? []) {
    const b = batch[s.i];
    if (!b) continue;
    const reason = (s.reason || "").split(/\s+/).slice(0, 6).join(" ");
    const category = catId(s.category);
    // The scorer returns product NAMES (resolved SW-side); map them to objects by
    // identity so a reorder/edit can't mis-point. Snapshot the objects on the opp.
    const products = category === "promote" && Array.isArray(s.products)
      ? s.products.map((n) => xProducts.find((p) => p.name === n)).filter((p): p is ProductItem => !!p).slice(0, 2)
      : undefined;
    const stat = snap[s.i] ?? {};
    seen.set(b.id, { score: s.score, reason, category, products, anchor: s.anchor, replyMove: s.replyMove, replyBrief: s.replyBrief, risk: s.risk, isReplyToOwnPost: b.isReplyToOwnPost || undefined });
    if (commentedIds.has(b.id)) {
      // Already replied to it — never surface it in the dock; keep only the green "✓ Commented" badge.
      if (opps.delete(b.id)) changed = true;
      if (statusInfo(b.el)?.id === b.id) badge(b.el, reason, category, s.score);
    } else if (s.score >= (b.isReplyToOwnPost ? 0.4 : THRESHOLD)) {
      opps.set(b.id, { id: b.id, author: b.author, text: b.text, score: s.score, reason, category, products, anchor: s.anchor, replyMove: s.replyMove, replyBrief: s.replyBrief, risk: s.risk, context: b.context, postedAt: stat.postedAt, likes: stat.likes, replies: stat.replies, views: stat.views, reposts: stat.reposts, avatar: stat.avatar, name: stat.name, verified: stat.verified, source: "feed", isReplyToOwnPost: b.isReplyToOwnPost || undefined });
      changed = true;
      if (statusInfo(b.el)?.id === b.id) badge(b.el, reason, category, effectiveScore(opps.get(b.id)!));
    } else {
      const ex = opps.get(b.id);
      if (ex?.manual) {
        // You pinned this one with "+ Add" — keep it, just refresh its real score/tag.
        ex.score = s.score; ex.reason = reason; ex.category = category; ex.anchor = s.anchor; ex.replyMove = s.replyMove; ex.replyBrief = s.replyBrief; ex.risk = s.risk;
        changed = true;
        if (statusInfo(b.el)?.id === b.id) badge(b.el, reason, category, effectiveScore(ex));
      } else {
        // Re-scored below threshold (e.g. after a Rescan): prune the stale spot + badge.
        if (opps.delete(b.id)) changed = true;
        if (b.el.isConnected) {
          clearPostOverlay(b.el);
          addButton(b.el);
        }
      }
    }
  }
  if (changed) renderDock();
  if (queue.length) scheduleFlush();
}

/** Manual rescan (dock button). Lifts the per-session cost cap and forgets prior
 *  scores so every post currently on screen is re-evaluated fresh. Keeps the
 *  opportunities already collected from scrolling — this refreshes, never wipes. */
/** Pause/resume the copilot. Paused = no scanning, surfacing, or API calls; the
 *  dock goes quiet until resumed. Persisted so it survives navigation + reload. */
function setPaused(v: boolean): void {
  paused = v;
  safeSet({ [CONFIG.X_PAUSED_KEY]: v });
  if (v) { dismissPanel(); if (dockPlayOpen) resetPlay(); } // close any open draft + collapse the playground while paused
  renderDock();
  if (v) { toast("Paused — the copilot is quiet until you resume."); }
  else { toast("Resumed — finding reply spots again."); rescan(); }
}

function rescan() {
  if (!enabled) { toast("Add your Anthropic key in the Goobi panel to enable scanning."); return; }
  if (paused) return; // a paused copilot doesn't scan, even on an explicit rescan
  scoreCalls = 0;        // user explicitly asked for more — reset the guard
  scanCapNotified = false;
  manualScanUntil = Date.now() + 2 * 60_000; // an explicit ask overrides the ease-off scan pause for one short window
  seen.clear();          // re-evaluate the visible feed from scratch
  queue.length = 0;      // drop anything half-queued
  for (const el of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) delete el.dataset.tbx;
  toast("Rescanning the page for reply spots…");
  touchGoobi();
  goobiSearchUntil = Date.now() + 2200; // Goobi perks up + looks around
  renderDock();
  setTimeout(() => { if (Date.now() >= goobiSearchUntil) renderDock(); }, 2300); // settle his mood after
  scan();
}

/* ---------- niche discovery (Twttr search → scored opportunities) ---------- */

let findingSpots = false;
type FindSpotsMode = "niche" | "fresh-reach";
const freshReachCheckedAt = new Map<string, number>();
const freshReachFailedAt = new Map<string, number>();
const FRESH_REACH_FAILURE_BACKOFF_MS = 10 * 60_000;
let freshReachWatchStore: FreshReachWatchStore = { ownerHandle: "", entries: [] };
let freshReachWatchAdding = false;
let freshReachWatchMsg = "";
const normalizeWatchHandle = (value: string): string => value.replace(/^@+/, "").trim().toLowerCase();
function normalizeFreshReachWatchStore(value: unknown, ownerHandle: string): FreshReachWatchStore {
  const owner = normalizeWatchHandle(ownerHandle);
  const raw = value && typeof value === "object" ? value as Partial<FreshReachWatchStore> : {};
  if (!owner || (raw.ownerHandle && normalizeWatchHandle(raw.ownerHandle) !== owner)) return { ownerHandle: owner, entries: [] };
  const byHandle = new Map<string, FreshReachWatchEntry>();
  for (const item of Array.isArray(raw.entries) ? raw.entries : []) {
    const handle = normalizeWatchHandle(item?.handle || "");
    if (!/^[a-z0-9_]{1,15}$/.test(handle) || !Number.isFinite(item?.followers) || item.followers <= 0) continue;
    const clean: FreshReachWatchEntry = {
      handle, followers: Math.round(item.followers), addedAt: Number.isFinite(item.addedAt) && item.addedAt > 0 ? item.addedAt : Date.now(),
      lastCheckedAt: Number.isFinite(item.lastCheckedAt) && (item.lastCheckedAt ?? 0) > 0 ? item.lastCheckedAt : undefined,
      checks: Number.isFinite(item.checks) && (item.checks ?? 0) > 0 ? Math.floor(item.checks!) : undefined,
      strongOpenings: Number.isFinite(item.strongOpenings) && (item.strongOpenings ?? 0) > 0 ? Math.floor(item.strongOpenings!) : undefined,
      openingPostIds: Array.isArray(item.openingPostIds) ? [...new Set(item.openingPostIds.filter((id) => typeof id === "string" && /^\d{5,30}$/.test(id)))].slice(-20) : undefined,
    };
    const previous = byHandle.get(handle);
    if (!previous || clean.addedAt > previous.addedAt) byHandle.set(handle, clean);
  }
  return { ownerHandle: owner, entries: [...byHandle.values()].sort((a, b) => a.addedAt - b.addedAt).slice(0, FRESH_REACH_WATCHLIST_MAX) };
}
function persistFreshReachWatchlist(): void { safeSet({ [CONFIG.X_FRESH_REACH_WATCHLIST_KEY]: freshReachWatchStore }); }
function watchEntry(handle: string): FreshReachWatchEntry | undefined {
  const key = normalizeWatchHandle(handle);
  return freshReachWatchStore.entries.find((entry) => entry.handle === key);
}
interface FreshReachRunReceipt {
  id: string; at: number; state: "searching" | "complete" | "failed";
  accountsChecked: number; originals: number; eligible: number; added: number;
  breakoutCandidates: number; majorCandidates: number;
  addedBreakouts: number; addedMajor: number;
  budgetLimited: boolean; bestOpening?: number; accountsDiscovered: number;
  radarSize: number; massiveSaved: number; shortlistSize: number;
  massiveChecked: number; shortlistChecked: number; watchlistChecked: number; note?: string;
}
let lastFreshReachRun: FreshReachRunReceipt | undefined;
const freshReachRunId = (): string => `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
let freshReachExploreIndex = 0;

function nextFreshReachExploreQuery(niche: string): string {
  const focused = nicheSearchQuery(niche);
  // The focused Top query is already fetched on every hunt. Skip it in the rotating exploration
  // lane so the very first click also expands into a distinct broad/focused account pool.
  const choices = freshReachExplorationQueries(niche).filter((query) => query !== focused);
  if (!choices.length) return nicheSearchQuery(niche);
  const query = choices[freshReachExploreIndex % choices.length];
  freshReachExploreIndex++;
  return query;
}

/** The compact user-specific massive-account keep-list, derived from settled reply views. */
function currentFreshReachShortlist(): FreshReachShortlistAccount[] {
  return freshReachShortlist(replyLog.sent, myFollowers);
}

function freshAccountSource(handle: string): FreshReachEvidence["accountSource"] {
  const key = handle.replace(/^@+/, "").toLowerCase();
  if (watchEntry(key)) return "watchlist";
  if (targetStore.targets.some((target) => target.handle.toLowerCase() === key)) return "tracked";
  if (heavyHitters.has(key)) return "heavy-hitter";
  return "latest";
}

/** Build a discovery-qualified account pool from the user's targets, persisted focused/broad Top
 * searches, and authors active in this niche Latest result. General feed authors are absent. */
function freshReachAccountPool(latest: readonly TwttrTweet[]): FreshReachAccount[] {
  const now = Date.now();
  const measuredAccounts = aggregateAccounts(replyLog.sent, now);
  const shortlist = syncFreshReachShortlistIntoRadar(); // also expires old winner flags before selection
  for (const [handle, heavy] of heavyHitters) {
    if (!heavy.at || now - heavy.at >= HEAVY_HITTER_TTL_MS) heavyHitters.delete(handle);
  }
  const pool = new Map<string, FreshReachAccount>();
  const merge = (account: FreshReachAccount): void => {
    const handle = account.handle.replace(/^@+/, "").trim().toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(handle) || (selfHandle && handle === selfHandle.toLowerCase())) return;
    const previous = pool.get(handle);
    pool.set(handle, {
      handle,
      followers: account.followers ?? previous?.followers,
      engagementRate: account.engagementRate ?? previous?.engagementRate,
      distributionScore: Math.max(account.distributionScore ?? 0, previous?.distributionScore ?? 0) || undefined,
      peakViews: Math.max(account.peakViews ?? 0, previous?.peakViews ?? 0) || undefined,
      peakEngagements: Math.max(account.peakEngagements ?? 0, previous?.peakEngagements ?? 0) || undefined,
      tracked: Boolean(account.tracked || previous?.tracked),
      watchlisted: Boolean(account.watchlisted || previous?.watchlisted),
      activeInLatest: Boolean(account.activeInLatest || previous?.activeInLatest),
      lastReplyAt: Math.max(account.lastReplyAt ?? 0, previous?.lastReplyAt ?? 0) || undefined,
      lastCheckedAt: Math.max(account.lastCheckedAt ?? 0, previous?.lastCheckedAt ?? 0) || undefined,
      checks: Math.max(account.checks ?? 0, previous?.checks ?? 0) || undefined,
      strongOpenings: Math.max(account.strongOpenings ?? 0, previous?.strongOpenings ?? 0) || undefined,
      shortlisted: Boolean(account.shortlisted || previous?.shortlisted),
      replyViewOutcomes: Math.max(account.replyViewOutcomes ?? 0, previous?.replyViewOutcomes ?? 0) || undefined,
      replyViewScore: Math.max(account.replyViewScore ?? 0, previous?.replyViewScore ?? 0) || undefined,
      bestReplyViews: Math.max(account.bestReplyViews ?? 0, previous?.bestReplyViews ?? 0) || undefined,
      discoveredAt: account.discoveredAt && previous?.discoveredAt ? Math.min(account.discoveredAt, previous.discoveredAt) : (account.discoveredAt ?? previous?.discoveredAt),
      measuredValue: account.measuredValue ?? previous?.measuredValue,
    });
  };
  for (const entry of freshReachWatchStore.entries) merge({
    handle: entry.handle,
    followers: entry.followers,
    watchlisted: true,
    lastReplyAt: replyLog.authors[entry.handle],
    lastCheckedAt: Math.max(entry.lastCheckedAt ?? 0, freshReachCheckedAt.get(entry.handle) ?? 0) || undefined,
    checks: entry.checks,
    strongOpenings: entry.strongOpenings,
    measuredValue: learnedMultForHandle(entry.handle, measuredAccounts),
  });
  for (const target of targetStore.targets) merge({
    handle: target.handle,
    followers: target.followers,
    tracked: true,
    lastReplyAt: replyLog.authors[target.handle.toLowerCase()],
    lastCheckedAt: Math.max(target.lastPolledAt ?? 0, freshReachCheckedAt.get(target.handle.toLowerCase()) ?? 0) || undefined,
    measuredValue: learnedMultForHandle(target.handle, measuredAccounts),
  });
  for (const winner of shortlist) merge({
    handle: winner.handle,
    followers: winner.followers,
    shortlisted: true,
    replyViewOutcomes: winner.outcomes,
    replyViewScore: winner.replyViewScore,
    bestReplyViews: winner.bestReplyViews,
    lastReplyAt: replyLog.authors[winner.handle],
    lastCheckedAt: Math.max(heavyHitters.get(winner.handle)?.lastCheckedAt ?? 0, freshReachCheckedAt.get(winner.handle) ?? 0) || undefined,
  });
  for (const [handle, heavy] of heavyHitters) merge({
    handle,
    followers: heavy.followers,
    engagementRate: heavy.engRate,
    distributionScore: decayFreshReachEvidence(heavy.distributionScore, heavy.lastSeenAt ?? heavy.discoveredAt, now),
    peakViews: heavy.peakViews,
    peakEngagements: heavy.peakEngagements,
    lastReplyAt: replyLog.authors[handle],
    lastCheckedAt: Math.max(heavy.lastCheckedAt ?? 0, freshReachCheckedAt.get(handle) ?? 0) || undefined,
    checks: heavy.checks,
    strongOpenings: heavy.strongOpenings,
    shortlisted: heavy.shortlisted,
    replyViewOutcomes: heavy.replyViewOutcomes,
    replyViewScore: heavy.replyViewScore,
    bestReplyViews: heavy.bestReplyViews,
    discoveredAt: heavy.discoveredAt,
    measuredValue: learnedMultForHandle(handle, measuredAccounts),
  });
  for (const post of latest) {
    const signals = freshReachPostSignals(post, now);
    merge({
      handle: post.author,
      followers: post.followers,
      activeInLatest: true,
      distributionScore: signals.distributionScore,
      peakViews: post.views,
      peakEngagements: signals.engagements,
      lastReplyAt: replyLog.authors[post.author.toLowerCase()],
      lastCheckedAt: freshReachCheckedAt.get(post.author.toLowerCase()),
      measuredValue: learnedMultForHandle(post.author, measuredAccounts),
    });
  }
  return [...pool.values()].filter((account) => {
    const failedAt = freshReachFailedAt.get(account.handle.toLowerCase());
    return !failedAt || now - failedAt >= FRESH_REACH_FAILURE_BACKOFF_MS;
  });
}

interface FreshReachAuthorHunt { posts: TwttrTweet[]; checked: number; massiveChecked: number; shortlistChecked: number; watchlistChecked: number; budgetLimited: boolean; }

/** Check a bounded account set directly. The provider does not honor a batched OR-from query, so
 * this uses small per-handle searches with limited concurrency; the governor caches each query for
 * 12 minutes and enforces local plus provider-reported budget limits. Tracked-account results also refresh Targets. */
async function fetchFreshReachAuthorPosts(accounts: readonly FreshReachAccount[]): Promise<FreshReachAuthorHunt> {
  const posts: TwttrTweet[] = [];
  let checked = 0, massiveChecked = 0, shortlistChecked = 0, watchlistChecked = 0, budgetLimited = false, targetsChanged = false;
  for (let i = 0; i < accounts.length; i += 3) {
    const batch = accounts.slice(i, i + 3);
    const results = await Promise.all(batch.map(async (account) => {
      const handle = account.handle.replace(/^@+/, "").trim().toLowerCase();
      const tracked = targetStore.targets.find((target) => target.handle.toLowerCase() === handle);
      const cached = tracked ? targetPosts.get(tracked.handle) : undefined;
      if (cached?.id && tracked?.lastPolledAt && Date.now() - tracked.lastPolledAt < TARGET_POLL_TTL_MS) {
        return { ok: true, handle, account, tracked, fromCache: true, tweets: [{
          ...cached, followers: account.followers, isReply: false,
        } satisfies TwttrTweet] };
      }
      const response = await send<{ ok?: boolean; data?: unknown; error?: string }>({
        type: "TWTTR_GET", path: "search-v3", query: { type: "Latest", count: "10", query: `from:${handle}` }, intent: true,
      });
      if (response?.error?.startsWith("budget-")) return { ok: false, handle, account, tracked, budget: true, tweets: [] as TwttrTweet[] };
      if (!response?.ok) { freshReachFailedAt.set(handle, Date.now()); return { ok: false, handle, account, tracked, tweets: [] as TwttrTweet[] }; }
      freshReachFailedAt.delete(handle);
      const tweets = parseTimelineTweets(response.data)
        .filter((post) => !post.isReply && post.text && post.author.toLowerCase() === handle)
        .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))
        .slice(0, 3)
        .map((post) => ({ ...post, followers: post.followers ?? account.followers }));
      return { ok: true, handle, account, tracked, tweets };
    }));
    for (const result of results) {
      if (result.budget) budgetLimited = true;
      if (!result.ok) continue;
      checked++;
      if (isMassiveFreshReachAccount(result.account.followers, myFollowers)) massiveChecked++;
      if (result.account.shortlisted) shortlistChecked++;
      if (result.account.watchlisted) watchlistChecked++;
      const checkedAt = Date.now();
      freshReachCheckedAt.set(result.handle, checkedAt);
      posts.push(...result.tweets);
      const watched = watchEntry(result.handle);
      if (watched && !result.fromCache) {
        watched.lastCheckedAt = checkedAt;
        watched.checks = (watched.checks ?? 0) + 1;
        watched.followers = result.tweets[0]?.followers ?? watched.followers;
        persistFreshReachWatchlist();
      }
      const radar = heavyHitters.get(result.handle);
      if (radar && !result.fromCache) {
        radar.lastCheckedAt = checkedAt;
        radar.checks = (radar.checks ?? 0) + 1;
        radar.latestPostId = result.tweets[0]?.id ?? radar.latestPostId;
        radar.at = checkedAt; // an explicit successful radar check keeps the saved account alive
        schedulePersistReach();
      }
      if (result.tracked && !result.fromCache) {
        const newest = result.tweets[0];
        result.tracked.lastPolledAt = checkedAt;
        if (newest?.id) result.tracked.lastFreshPostId = newest.id;
        targetPosts.set(result.tracked.handle, newest ? {
          id: newest.id, text: newest.text, postedAt: newest.postedAt, author: newest.author,
          replies: newest.replies, likes: newest.likes, reposts: newest.reposts, quotes: newest.quotes, views: newest.views,
        } : { id: "", text: "", author: result.tracked.handle });
        targetsChanged = true;
      }
    }
  }
  if (targetsChanged) persistTargets();
  return { posts, checked, massiveChecked, shortlistChecked, watchlistChecked, budgetLimited };
}
/** Search X (via the Twttr API) for fresh posts in the user's niche, score them
 *  with the same Claude scorer the feed uses, and drop the worthwhile ones into
 *  the dock. These are OFF the current page: Draft/Copy work, but inserting into
 *  a reply box needs the post opened (the panel/toast guide that). */
async function findSpots(mode: FindSpotsMode = "niche") {
  if (findingSpots) return;
  if (!enabled) { toast("Add your Anthropic key in the Goobi panel to score posts."); return; }
  const q = xNiche.trim();
  if (!q) { toast("Set your niche in the Goobi panel so it knows what to search for."); return; }
  if (mode === "fresh-reach" && !myFollowers) {
    toast("Set your X handle in the Goobi panel first so Fresh Reach can compare practical and massive account opportunities.");
    return;
  }
  const runId = mode === "fresh-reach" ? freshReachRunId() : "";
  if (mode === "fresh-reach") lastFreshReachRun = {
    id: runId, at: Date.now(), state: "searching", accountsChecked: 0,
    originals: 0, eligible: 0, added: 0, budgetLimited: false,
    breakoutCandidates: 0, majorCandidates: 0, addedBreakouts: 0, addedMajor: 0,
    accountsDiscovered: 0, radarSize: heavyHitters.size,
    massiveSaved: [...heavyHitters.values()].filter((entry) => isMassiveFreshReachAccount(entry.followers, myFollowers)).length,
    shortlistSize: currentFreshReachShortlist().length, massiveChecked: 0, shortlistChecked: 0, watchlistChecked: 0,
  };
  findingSpots = true;
  renderDock();
  toast(mode === "fresh-reach"
    ? "Hunting proven breakout distribution and unusually early openings on major accounts…"
    : "Searching X for fresh posts in your niche…");
  try {
    // Every explicit Fresh click expands the saved account radar with one rotating, operator-free
    // Top query while Latest searches current posts. The governor/cache still bound network cost.
    const radarBefore = heavyHitters.size;
    const explorationQuery = mode === "fresh-reach" ? nextFreshReachExploreQuery(q) : "";
    const heavyRefresh = mode === "fresh-reach"
      ? findHeavyHitters(true, [nicheSearchQuery(q), explorationQuery])
      : Promise.resolve({ discovered: 0, total: heavyHitters.size, budgetLimited: false });
    const [search, radarRefresh] = await Promise.all([
      send<{ ok?: boolean; status?: number; data?: unknown; error?: string }>({
        type: "TWTTR_GET", path: "search-v3", query: { type: "Latest", count: mode === "fresh-reach" ? "50" : "30", query: nicheSearchQuery(q) }, intent: true, // OR the topics so it matches ANY, not ALL keywords (intent clause dropped)
      }),
      heavyRefresh,
    ]);
    if (search?.error === "no-twttr-config") { twttrUnconfigured = true; toast("Add your RapidAPI key in the Goobi panel to find spots."); return; }
    if (search?.error?.startsWith("budget-")) { toast("The local/provider X-data safety budget is nearly used — Find spots is paused. Check RapidAPI for the billing-cycle reset."); return; }
    let latestUnavailable = false;
    if (!search?.ok) {
      const s = search?.status;
      const querySpecificFailure = s != null && s >= 400 && s < 500 && ![401, 402, 403, 429].includes(s);
      const hasSavedAccounts = mode === "fresh-reach"
        && (freshReachWatchStore.entries.length > 0 || targetStore.targets.length > 0 || heavyHitters.size > 0 || currentFreshReachShortlist().length > 0);
      if (querySpecificFailure && hasSavedAccounts) {
        latestUnavailable = true;
        if (lastFreshReachRun?.id === runId) lastFreshReachRun.note = `Latest unavailable${s ? ` (HTTP ${s})` : ""}; checked saved accounts only.`;
        toast(`Latest search failed${s ? ` (HTTP ${s})` : ""}; checking your saved Fresh Reach accounts directly instead.`);
      } else {
        const why = s === 401 || s === 402 || s === 403
          ? "Key invalid or not subscribed to twitter241 on RapidAPI."
          : s === 429 ? "RapidAPI rate limit reached; wait for the provider reset."
            : "Check your RapidAPI key and provider status in the popup.";
        toast(`X search failed${s ? ` (HTTP ${s})` : ""}. ${why}${search?.error ? ` — provider says: ${search.error}` : ""}`);
        return;
      }
    }
    if (!selfHandle) selfHandle = getSelf();
    let originals = pickDiscoveryTweets(latestUnavailable ? undefined : search?.data, mode === "fresh-reach" ? 50 : 18)
      .filter((t) => !selfHandle || t.author.toLowerCase() !== selfHandle);
    let freshHunt: FreshReachAuthorHunt = { posts: [], checked: 0, massiveChecked: 0, shortlistChecked: 0, watchlistChecked: 0, budgetLimited: false };
    const directlyCheckedAuthors = new Set<string>();
    const accountPriorityByHandle = new Map<string, number>();
    if (mode === "fresh-reach") {
      captureFreshRadarTweets(originals, "latest");
      const pool = freshReachAccountPool(originals);
      const rankedAccounts = pickFreshReachAccounts(pool, myFollowers, Date.now(), pool.length);
      for (const candidate of rankedAccounts) accountPriorityByHandle.set(candidate.account.handle.toLowerCase(), candidate.priority);
      // A broad Latest result that already gives us an eligible original is useful now. Do not pay
      // for an author-specific duplicate check; spend the twelve slots on accounts Latest missed.
      const covered = new Set(pickFreshReachCandidates(
        originals, myFollowers, Date.now(), replyLog.authors, originals.length,
      ).map((candidate) => candidate.post.author.toLowerCase()));
      const accounts = rankedAccounts
        .filter((candidate) => !covered.has(candidate.account.handle.toLowerCase()))
        .slice(0, FRESH_REACH_ACCOUNT_CHECKS)
        .map((candidate) => candidate.account);
      freshHunt = await fetchFreshReachAuthorPosts(accounts);
      for (const post of freshHunt.posts) directlyCheckedAuthors.add(post.author.toLowerCase());
      const byId = new Map<string, TwttrTweet>();
      for (const post of [...originals, ...freshHunt.posts]) {
        if (!selfHandle || post.author.toLowerCase() !== selfHandle) byId.set(post.id, post);
      }
      originals = [...byId.values()];
    }
    // Keep a wider, two-post-per-author set until Claude judges actual contribution quality. The
    // old opportunity-only top-12 could let twelve generic celebrity posts hide a relevant #13,
    // and a generic newest post could hide a better older post by the same author.
    const freshCandidates = mode === "fresh-reach"
      ? pickFreshReachCandidates(originals, myFollowers, Date.now(), replyLog.authors, 24, 2)
      : [];
    const discovered = mode === "fresh-reach" ? freshCandidates.map((candidate) => candidate.post) : originals;
    const evidenceById = new Map<string, FreshReachEvidence>();
    const observedAt = Date.now();
    for (const candidate of freshCandidates) evidenceById.set(candidate.post.id, {
      runId, discoveredAt: observedAt, observedAt,
      expiresAt: (candidate.post.postedAt ?? observedAt) + FRESH_REACH_MAX_AGE_MS,
      repliesObserved: candidate.post.replies!, sizeMultiple: candidate.sizeMultiple,
      accountSource: freshAccountSource(candidate.post.author),
      accountPriority: accountPriorityByHandle.get(candidate.post.author.toLowerCase()) ?? 0,
      observedOpportunity: candidate.opportunity, contentFit: 0, kind: candidate.kind,
      viewsObserved: candidate.post.views,
      engagementsObserved: candidate.signals.engagements,
      viewsPerMinute: candidate.signals.viewsPerMinute,
      engagementsPerMinute: candidate.signals.engagementsPerMinute,
      distributionScore: candidate.signals.distributionScore,
    });
    if (mode === "fresh-reach" && lastFreshReachRun?.id === runId) Object.assign(lastFreshReachRun, {
      state: "complete", accountsChecked: freshHunt.checked, originals: originals.length,
      eligible: freshCandidates.length, budgetLimited: freshHunt.budgetLimited || radarRefresh.budgetLimited,
      breakoutCandidates: freshCandidates.filter((candidate) => candidate.kind === "breakout").length,
      majorCandidates: freshCandidates.filter((candidate) => candidate.kind === "major-early").length,
      accountsDiscovered: Math.max(radarRefresh.discovered, heavyHitters.size - radarBefore),
      radarSize: heavyHitters.size,
      massiveSaved: [...heavyHitters.values()].filter((entry) => isMassiveFreshReachAccount(entry.followers, myFollowers)).length,
      shortlistSize: currentFreshReachShortlist().length,
      massiveChecked: freshHunt.massiveChecked,
      shortlistChecked: freshHunt.shortlistChecked,
      watchlistChecked: freshHunt.watchlistChecked,
      note: latestUnavailable ? lastFreshReachRun.note : undefined,
    });
    // Refresh every returned original before applying the strict Fresh screen. A post that crossed
    // the age/reply boundary must lose its live Fresh claim instead of keeping stale metrics merely
    // because it no longer appears in `discovered`.
    const observed = mode === "fresh-reach" ? originals : discovered;
    let refreshed = 0;
    observeOpportunityTweets(observed);
    for (const t of observed) {
      const existing = opps.get(t.id);
      if (!existing) continue;
      const nextMetrics = {
        postedAt: t.postedAt ?? existing.postedAt, likes: t.likes ?? existing.likes,
        replies: t.replies ?? existing.replies, reposts: t.reposts ?? existing.reposts,
        quotes: t.quotes ?? existing.quotes, views: t.views ?? existing.views, followers: t.followers ?? existing.followers,
      };
      if (nextMetrics.postedAt !== existing.postedAt || nextMetrics.likes !== existing.likes
        || nextMetrics.replies !== existing.replies || nextMetrics.reposts !== existing.reposts
        || nextMetrics.quotes !== existing.quotes || nextMetrics.views !== existing.views || nextMetrics.followers !== existing.followers) refreshed++;
      Object.assign(existing, nextMetrics);
      if (mode === "fresh-reach" && freshReachCandidate(t, myFollowers, Date.now(), replyLog.authors[t.author.toLowerCase()])) {
        existing.source = "fresh-reach"; // provenance remains manual-only; live eligibility is rechecked at display/draft time
        const evidence = evidenceById.get(t.id);
        if (evidence) existing.freshReach = { ...evidence, contentFit: existing.score };
      }
    }
    if (!discovered.length) {
      toast(mode === "fresh-reach"
        ? `Radar ${heavyHitters.size} · keep-list ${currentFreshReachShortlist().length}${lastFreshReachRun?.accountsDiscovered ? ` · saved ${lastFreshReachRun.accountsDiscovered} new` : ""}. ${freshHunt.checked ? `Scanned ${freshHunt.checked} ${freshHunt.checked === 1 ? "account" : "accounts"}${freshHunt.massiveChecked ? ` (${freshHunt.massiveChecked} massive${freshHunt.watchlistChecked ? `, ${freshHunt.watchlistChecked} pinned` : ""})` : ""}${latestUnavailable ? " from the saved radar" : " plus Latest"}. ` : ""}No just-posted, uncrowded eligible opening right now${freshHunt.budgetLimited ? " — the data budget limited some account checks" : ""}.`
        : "X returned no usable posts for this niche right now.");
      return;
    }
    const found = discovered.filter((t) => !opps.has(t.id) && !seen.has(t.id));
    if (!found.length) {
      const rising = discovered.filter((t) => opps.has(t.id) && t.postedAt != null && Date.now() - t.postedAt <= 2 * HOUR_MS && slotOdds(t.replies) > 0.45 && (opportunityMomentum(t.id)?.score ?? 0) >= 0.25).length;
      toast(refreshed
        ? `Refreshed ${refreshed} ${refreshed === 1 ? "spot" : "spots"}${rising ? ` · ${rising} picking up` : ""}. No new matches this time.`
        : `Checked ${discovered.length} posts. No new high-fit spots this time.`);
      return;
    }
    const posts = found.map((t, i) => ({ i, author: t.author, text: t.text.slice(0, 400) }));
    // Two bounded model calls preserve response completeness at the 24-post deep-scan ceiling; one
    // 1,536-token JSON response can truncate before returning every row. Indices stay global.
    const scoreBatches = Array.from({ length: Math.ceil(posts.length / 12) }, (_, i) => posts.slice(i * 12, i * 12 + 12));
    const scoreResponses = await Promise.all(scoreBatches.map((batch) =>
      send<{ scores?: ScoredPost[]; error?: string }>({ type: "SCORE_POSTS", posts: batch })));
    if (scoreResponses.some((response) => response?.error === "no-key")) { toast("Add your Anthropic key in the Goobi panel to score posts."); return; }
    if (scoreResponses.some((response) => !response || response.error)) { toast("Couldn't score the posts — try again."); return; }
    const scores = scoreResponses.flatMap((response) => response?.scores ?? []);
    // Fresh Reach keeps only the best CONTENT × observed-opening result per author after scoring.
    // This preserves API recall without letting one prolific account crowd the final queue.
    const freshChosenIds = new Set<string>();
    if (mode === "fresh-reach") {
      const bestByAuthor = new Map<string, { id: string; opening: number }>();
      for (const s of scores) {
        const t = found[s.i];
        const evidence = t ? evidenceById.get(t.id) : undefined;
        if (!t || !evidence || !freshReachContentEligible(s)
          || !freshReachCandidate(t, myFollowers, Date.now(), replyLog.authors[t.author.toLowerCase()])) continue;
        const opening = freshReachOpeningScore({ contentFit: s.score, observedOpportunity: evidence.observedOpportunity, momentum: opportunityMomentum(t.id)?.score });
        const handle = t.author.toLowerCase();
        const previous = bestByAuthor.get(handle);
        if (!previous || opening > previous.opening) bestByAuthor.set(handle, { id: t.id, opening });
      }
      for (const row of bestByAuthor.values()) freshChosenIds.add(row.id);
    }
    let added = 0, addedBreakouts = 0, addedMajor = 0;
    let bestOpening = 0;
    for (const s of scores) {
      const t = found[s.i];
      if (!t) continue;
      const reason = (s.reason || "").split(/\s+/).slice(0, 6).join(" ");
      const category = catId(s.category);
      const products = category === "promote" && Array.isArray(s.products)
        ? s.products.map((n) => xProducts.find((p) => p.name === n)).filter((p): p is ProductItem => !!p).slice(0, 2)
        : undefined;
      seen.set(t.id, { score: s.score, reason, category, products, anchor: s.anchor, replyMove: s.replyMove, replyBrief: s.replyBrief, risk: s.risk });
      const stillEligible = mode !== "fresh-reach"
        || !!freshReachCandidate(t, myFollowers, Date.now(), replyLog.authors[t.author.toLowerCase()]);
      const contentEligible = mode === "fresh-reach" ? freshReachContentEligible(s) : s.score >= THRESHOLD;
      if (contentEligible && stillEligible && (mode !== "fresh-reach" || freshChosenIds.has(t.id))) {
        const evidence = evidenceById.get(t.id);
        if (evidence) {
          evidence.contentFit = s.score;
          evidence.openingScore = freshReachOpeningScore({
            contentFit: s.score,
            observedOpportunity: evidence.observedOpportunity,
            momentum: opportunityMomentum(t.id)?.score,
          });
          bestOpening = Math.max(bestOpening, evidence.openingScore);
        }
        if (mode === "fresh-reach") {
          if (evidence?.kind === "breakout") addedBreakouts++;
          if (evidence?.kind === "major-early") addedMajor++;
          const handle = t.author.toLowerCase();
          if (directlyCheckedAuthors.has(handle)) {
            const radar = heavyHitters.get(handle);
            if (radar && !radar.openingPostIds?.includes(t.id)) {
              radar.openingPostIds = [...(radar.openingPostIds ?? []), t.id].slice(-20);
              radar.strongOpenings = radar.openingPostIds.length;
              radar.at = Date.now();
              schedulePersistReach();
            }
            const watched = watchEntry(handle);
            if (watched && !watched.openingPostIds?.includes(t.id)) {
              watched.openingPostIds = [...(watched.openingPostIds ?? []), t.id].slice(-20);
              watched.strongOpenings = watched.openingPostIds.length;
              persistFreshReachWatchlist();
            }
          }
        }
        opps.set(t.id, { id: t.id, author: t.author, text: t.text.slice(0, 400), score: s.score, reason, category, products, anchor: s.anchor, replyMove: s.replyMove, replyBrief: s.replyBrief, risk: s.risk, postedAt: t.postedAt, likes: t.likes, replies: t.replies, reposts: t.reposts, quotes: t.quotes, views: t.views, avatar: t.avatar, name: t.name, followers: t.followers, source: mode === "fresh-reach" ? "fresh-reach" : "search", freshReach: evidence });
        if (t.author && t.followers != null) {
          const key = t.author.toLowerCase();
          authorReach.set(key, { ...authorReach.get(key), followers: t.followers, at: Date.now(), failed: false });
          schedulePersistReach();
        } // search gives reach; preserve richer profile evidence if it was already fetched
        added++;
      }
    }
    if (mode === "fresh-reach" && lastFreshReachRun?.id === runId) {
      lastFreshReachRun.added = added;
      lastFreshReachRun.addedBreakouts = addedBreakouts;
      lastFreshReachRun.addedMajor = addedMajor;
      lastFreshReachRun.bestOpening = bestOpening || undefined;
    }
    toast(added
      ? mode === "fresh-reach"
        ? `Radar ${heavyHitters.size} · keep-list ${currentFreshReachShortlist().length} · found ${added} strong ${added === 1 ? "opening" : "openings"}${addedBreakouts ? ` · ${addedBreakouts} breakout` : ""}${addedMajor ? ` · ${addedMajor} major + early` : ""}${lastFreshReachRun?.accountsDiscovered ? ` · saved ${lastFreshReachRun.accountsDiscovered} new ${lastFreshReachRun.accountsDiscovered === 1 ? "account" : "accounts"}` : ""}. The best observed opening is pinned first.`
        : `Found ${added} fresh reply ${added === 1 ? "spot" : "spots"} in your niche.`
      : mode === "fresh-reach"
        ? `Radar ${heavyHitters.size} · keep-list ${currentFreshReachShortlist().length}${lastFreshReachRun?.accountsDiscovered ? ` · saved ${lastFreshReachRun.accountsDiscovered} new` : ""}. Scored ${discovered.length} live candidates; none had a strong enough specific contribution this time.`
        : `Checked ${discovered.length} posts. No new high-fit spots this time.`);
  } finally {
    if (mode === "fresh-reach" && lastFreshReachRun?.id === runId && lastFreshReachRun.state === "searching") {
      lastFreshReachRun.state = "failed";
      lastFreshReachRun.note = "The data search did not complete.";
    }
    findingSpots = false;
    renderDock();
  }
}

/* ---------- in-post decision overlay (idempotent; survives X re-renders) ---------- */

/** Validate a model-returned category against the known angle ids. */
function catId(id?: string): string | undefined {
  return id && REPLY_ANGLES.some((a) => a.id === id) ? id : undefined;
}
/** Human label for a category id (the angle's label), or "Reply" fallback. */
function catLabel(id?: string): string {
  return REPLY_ANGLES.find((a) => a.id === id)?.label || "Reply";
}
/** "3 Value · 2 Promote · 1 Ask" — top categories across the collected opps. */
function catSummary(): string {
  const counts = new Map<string, number>();
  for (const o of opps.values()) if (o.category) counts.set(o.category, (counts.get(o.category) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, c]) => `${c} ${catLabel(id)}`).join(" · ");
}

type PostOverlayKind = "surfaced" | "passed";
interface PostOverlayModel {
  kind: PostOverlayKind;
  id: string;
  author: string;
  reason: string;
  category?: string;
  score?: number;
  done: boolean;
  opp?: Opp;
  recommendation?: ReplyRecommendation;
  isReplyToOwnPost?: boolean;
}

const postOverlayModels = new WeakMap<HTMLElement, PostOverlayModel>();
const postOriginalBorders = new WeakMap<HTMLElement, { left: string; topRadius: string; bottomRadius: string }>();
const postOpenLayers = new WeakMap<HTMLElement, Array<{ el: HTMLElement; position: string; zIndex: string; overflow: string }>>();
let activePostOverlay: HTMLElement | null = null;
let postOverlayOutsideBound = false;

function stopPostAction(e: Event): void { e.stopPropagation(); e.preventDefault(); }

function elevateOpenPost(host: HTMLElement, article: HTMLElement): void {
  if (postOpenLayers.has(host)) return;
  const cell = article.closest<HTMLElement>('[data-testid="cellInnerDiv"]');
  const layers = [...new Set([cell, article].filter((node): node is HTMLElement => !!node))].map((el) => ({
    el, position: el.style.position, zIndex: el.style.zIndex, overflow: el.style.overflow,
  }));
  postOpenLayers.set(host, layers);
  for (const layer of layers) {
    if (getComputedStyle(layer.el).position === "static") layer.el.style.position = "relative";
    layer.el.style.zIndex = "2147483000";
    layer.el.style.overflow = "visible";
  }
}

function restoreOpenPost(host: HTMLElement): void {
  const layers = postOpenLayers.get(host); if (!layers) return;
  for (const layer of layers) {
    layer.el.style.position = layer.position;
    layer.el.style.zIndex = layer.zIndex;
    layer.el.style.overflow = layer.overflow;
  }
  postOpenLayers.delete(host);
}

function closePostOverlay(host?: HTMLElement | null): void {
  const target = host || activePostOverlay;
  if (!target) return;
  const pop = target.querySelector<HTMLElement>("[data-tbx-pop]");
  const pill = target.querySelector<HTMLElement>("[data-tbx-pill]");
  if (pop && !pop.hidden) pop.hidden = true;
  if (pill?.getAttribute("aria-expanded") !== "false") pill?.setAttribute("aria-expanded", "false");
  restoreOpenPost(target);
  if (activePostOverlay === target) activePostOverlay = null;
}

function clearPostOverlay(el: HTMLElement): void {
  const badgeHost = el.querySelector<HTMLElement>("[data-tbx-badge]");
  const addHost = el.querySelector<HTMLElement>("[data-tbx-add]");
  if (badgeHost === activePostOverlay) closePostOverlay(badgeHost);
  if (addHost === activePostOverlay) closePostOverlay(addHost);
  badgeHost?.remove(); addHost?.remove();
  postOverlayModels.delete(el);
  const original = postOriginalBorders.get(el);
  if (original) {
    el.style.borderLeft = original.left;
    el.style.borderTopLeftRadius = original.topRadius;
    el.style.borderBottomLeftRadius = original.bottomRadius;
    postOriginalBorders.delete(el);
  }
}

function postOverlayColor(model: PostOverlayModel): { bg: string; fg: string; border: string } {
  if (model.done) return { bg: DONE, fg: DONE_INK, border: DONE };
  if (model.kind === "passed") return { bg: "rgba(29,24,18,.94)", fg: "#b6a892", border: "rgba(214,154,92,.38)" };
  if (model.recommendation?.authorRepeat) return { bg: "#e89a3c", fg: "#211406", border: "#e89a3c" };
  if (model.recommendation?.lane === "inbound" || model.recommendation?.lane === "continue") return { bg: "#6fcf7f", fg: "#102016", border: "#6fcf7f" };
  if (model.recommendation?.lane === "community") return { bg: "#5dcaa5", fg: "#0c2119", border: "#5dcaa5" };
  return { bg: ACCENT, fg: INK, border: ACCENT };
}

function shortStrength(rec?: ReplyRecommendation): string {
  return rec?.strength === "best next" ? "best" : rec?.strength === "good option" ? "good" : "later";
}

function postOverlayLabel(model: PostOverlayModel): string {
  if (model.done) return "✓ Replied";
  if (model.isReplyToOwnPost) return model.kind === "passed"
    ? "↩ Your post · passed"
    : `↩ They replied to your post · ${shortStrength(model.recommendation)}`;
  if (model.kind === "passed") return "Goobi passed";
  if (model.recommendation?.authorRepeat) return `↻ Replied ${model.recommendation.authorRepeat.label} · ${shortStrength(model.recommendation)}`;
  return model.recommendation
    ? `✦ ${model.recommendation.laneLabel} · ${shortStrength(model.recommendation)}`
    : `✦ ${catLabel(model.category)}`;
}

function postOverlayAction(label: string, primary: boolean, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = label;
  Object.assign(button.style, {
    minHeight: "32px", padding: "6px 9px", borderRadius: "8px", cursor: "pointer",
    border: primary ? "1px solid transparent" : "1px solid rgba(214,154,92,.24)",
    background: primary ? ACCENT : "#221c15", color: primary ? INK : "#f3ead9",
    font: "600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  } as Partial<CSSStyleDeclaration>);
  button.addEventListener("click", (e) => { stopPostAction(e); run(); });
  return button;
}

function postOverlayText(text: string, color = "#b6a892", size = "12px"): HTMLDivElement {
  const div = document.createElement("div"); div.textContent = text;
  Object.assign(div.style, { color, fontSize: size, lineHeight: "1.4" } as Partial<CSSStyleDeclaration>);
  return div;
}

function postOverlayDetailKey(model: PostOverlayModel): string {
  const rec = model.recommendation;
  return JSON.stringify([
    model.kind, model.id, model.reason, model.category, model.score, model.done,
    model.isReplyToOwnPost,
    rec?.lane, rec?.strength, rec?.confidence, rec?.discovery, rec?.relationship,
    rec?.community, rec?.reasons, rec?.cautions, rec?.authorRepeat,
  ]);
}

function renderPostOverlayDetails(el: HTMLElement, host: HTMLElement, model: PostOverlayModel): void {
  const pop = host.querySelector<HTMLElement>("[data-tbx-pop]");
  if (!pop) return;
  pop.replaceChildren();

  const header = document.createElement("div");
  Object.assign(header.style, { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px" });
  const heading = document.createElement("div");
  const title = document.createElement("div");
  title.textContent = model.done ? "Reply recorded" : model.isReplyToOwnPost ? `They replied to your post · ${model.recommendation?.strength || (model.kind === "passed" ? "passed" : "recommended")}` : model.kind === "passed" ? "Not in your reply queue" : model.recommendation?.authorRepeat ? `Spread your replies · ${model.recommendation.strength}` : `${model.recommendation?.laneLabel || catLabel(model.category)} · ${model.recommendation?.strength || "recommended"}`;
  Object.assign(title.style, { color: "#f7efe2", fontSize: "13px", fontWeight: "700", lineHeight: "1.3" });
  const sub = postOverlayText(`@${model.author} · ${catLabel(model.category)}`, "#8c7d68", "11px");
  sub.style.marginTop = "2px"; heading.append(title, sub);
  const close = document.createElement("button"); close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Close Goobi post details");
  Object.assign(close.style, { width: "28px", height: "28px", border: "0", borderRadius: "7px", background: "transparent", color: "#b6a892", cursor: "pointer", fontSize: "18px", lineHeight: "1" });
  close.addEventListener("click", (e) => { stopPostAction(e); closePostOverlay(host); });
  header.append(heading, close); pop.append(header);

  if (model.done) {
    const done = postOverlayText("Goobi will leave this conversation out of your active reply queue.");
    done.style.marginTop = "10px"; pop.append(done);
  } else if (model.kind === "surfaced" && model.recommendation) {
    const rec = model.recommendation;
    if (model.isReplyToOwnPost) {
      const inbound = postOverlayText("This is a direct comment on one of your posts. Goobi treats warm inbound conversation as more important than cold outreach.", "#9be5aa", "11.5px");
      Object.assign(inbound.style, { marginTop: "10px", padding: "8px 9px", borderRadius: "8px", background: "rgba(111,207,127,.10)", border: "1px solid rgba(111,207,127,.28)" });
      pop.append(inbound);
    }
    if (rec.authorRepeat) {
      const warning = postOverlayText(model.isReplyToOwnPost
        ? `You already replied to @${model.author} ${rec.authorRepeat.label}. Because they commented on your post, Goobi kept this important as an ongoing conversation. Reply only if you have something useful to add.`
        : `You already replied to @${model.author} ${rec.authorRepeat.label}. Goobi lowered Reach, Relationship, and Community to help avoid a repeat-author spam pattern. Continue only for a real ongoing conversation.`, "#f0b66f", "11.5px");
      Object.assign(warning.style, { marginTop: "10px", padding: "8px 9px", borderRadius: "8px", background: "rgba(232,154,60,.11)", border: "1px solid rgba(232,154,60,.3)" });
      pop.append(warning);
    }
    const why = document.createElement("div"); why.style.marginTop = "11px";
    const whyLabel = postOverlayText("WHY NOW", "#d69a5c", "10px"); whyLabel.style.fontWeight = "800"; whyLabel.style.letterSpacing = ".7px";
    const uniqueReasons = [...new Set([model.reason, ...rec.reasons].filter(Boolean))];
    const whyText = postOverlayText(uniqueReasons.join(" · ") || "Relevant conversation with room for a useful reply.", "#f3ead9"); whyText.style.marginTop = "3px";
    why.append(whyLabel, whyText); pop.append(why);

    const signals = document.createElement("div");
    signals.title = "Decision signals, not predicted probabilities.";
    Object.assign(signals.style, { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "5px", marginTop: "10px" });
    ([['Reach', rec.discovery], ['Relationship', rec.relationship], ['Community', rec.community]] as Array<[string, number]>).forEach(([label, value]) => {
      const cell = document.createElement("div");
      Object.assign(cell.style, { padding: "6px 5px", borderRadius: "7px", background: "#221c15", border: "1px solid rgba(214,154,92,.13)", textAlign: "center" });
      const valueEl = postOverlayText(`${Math.round(value * 100)}`, "#f7efe2", "12px"); valueEl.style.fontWeight = "800";
      const labelEl = postOverlayText(label, "#8c7d68", "9px");
      cell.append(valueEl, labelEl); signals.append(cell);
    });
    pop.append(signals);
    const evidence = postOverlayText(`${rec.confidence}${rec.cautions[0] ? ` · ${rec.cautions[0]}` : ""}`, "#8c7d68", "10.5px");
    evidence.style.marginTop = "7px"; pop.append(evidence);
  } else {
    const why = postOverlayText(`Goobi passed because: ${model.reason || "lower fit for your current growth priorities"}.`, "#d8c9b2");
    why.style.marginTop = "11px"; pop.append(why);
    if (model.score != null) {
      const fit = postOverlayText(`Content-fit signal ${Math.round(Math.max(0, Math.min(1, model.score)) * 100)}/100 · not a reach prediction`, "#8c7d68", "10.5px");
      fit.style.marginTop = "5px"; pop.append(fit);
    }
  }

  const actions = document.createElement("div");
  Object.assign(actions.style, { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "12px" });
  const openThread = () => window.open(`https://x.com/${model.author}/status/${model.id}`, "_blank", "noopener");
  if (model.done) {
    actions.append(postOverlayAction("Open thread ↗", false, openThread));
  } else if (model.kind === "surfaced") {
    actions.append(
      postOverlayAction("Draft reply", true, () => { closePostOverlay(host); void openDraftFromEl(el); }),
      postOverlayAction("Open ↗", false, openThread),
      postOverlayAction("Mark replied", false, () => {
        const current = opps.get(model.id) || model.opp;
        if (!current) { toast("That reply spot is no longer in your queue."); return; }
        closePostOverlay(host); recordSentReply("", current, undefined, Date.now(), "manual");
        badge(el, current.reason, current.category, model.score); toast("Marked as replied.");
      }),
      postOverlayAction("Skip", false, () => {
        closePostOverlay(host); opps.delete(model.id); clearPostOverlay(el); addButton(el); renderDock(); toast("Removed from your reply queue.");
      }),
    );
  } else {
    actions.append(
      postOverlayAction("Add to queue", true, () => { closePostOverlay(host); void addManual(el); }),
      postOverlayAction("Draft anyway", false, () => { closePostOverlay(host); void openDraftFromEl(el); }),
      postOverlayAction("Open ↗", false, openThread),
    );
  }
  pop.append(actions);
  host.dataset.tbxDetailsKey = postOverlayDetailKey(model);
}

function ensurePostOverlay(el: HTMLElement, model: PostOverlayModel): HTMLElement {
  const desired = model.kind === "surfaced" ? "data-tbx-badge" : "data-tbx-add";
  const other = model.kind === "surfaced" ? "data-tbx-add" : "data-tbx-badge";
  const otherHost = el.querySelector<HTMLElement>(`[${other}]`);
  if (otherHost === activePostOverlay) closePostOverlay(otherHost);
  otherHost?.remove();
  let host = el.querySelector<HTMLElement>(`[${desired}]`);
  // Upgrade the old single-button treatment in place after an extension refresh.
  if (host && (!host.querySelector("[data-tbx-pill]") || host.tagName === "BUTTON")) { host.remove(); host = null; }
  if (!host) {
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    host = document.createElement("div"); host.setAttribute(desired, "1");
    Object.assign(host.style, { position: "absolute", top: "10px", right: "60px", zIndex: "2147483600", fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif" } as Partial<CSSStyleDeclaration>);
    const pill = document.createElement("button"); pill.type = "button"; pill.setAttribute("data-tbx-pill", "1"); pill.setAttribute("aria-expanded", "false");
    Object.assign(pill.style, { borderRadius: "999px", padding: "4px 10px", cursor: "pointer", font: "700 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif", boxShadow: "0 2px 10px rgba(0,0,0,.18)", whiteSpace: "nowrap" } as Partial<CSSStyleDeclaration>);
    const pop = document.createElement("div"); pop.setAttribute("data-tbx-pop", "1"); pop.hidden = true; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Goobi post recommendation details");
    Object.assign(pop.style, { position: "absolute", top: "calc(100% + 7px)", right: "0", zIndex: "2147483647", width: "292px", maxWidth: "calc(100vw - 32px)", boxSizing: "border-box", padding: "12px", borderRadius: "12px", background: "#1d1812", color: "#f3ead9", border: "1px solid rgba(214,154,92,.24)", boxShadow: "0 14px 38px rgba(0,0,0,.48)", textAlign: "left" } as Partial<CSSStyleDeclaration>);
    pill.addEventListener("click", (e) => {
      stopPostAction(e);
      const latest = postOverlayModels.get(el); if (!latest) return;
      const opening = pop.hidden;
      if (activePostOverlay && activePostOverlay !== host) closePostOverlay(activePostOverlay);
      if (!opening) { closePostOverlay(host); return; }
      elevateOpenPost(host!, el); renderPostOverlayDetails(el, host!, latest); pop.hidden = false; pill.setAttribute("aria-expanded", "true"); activePostOverlay = host;
    });
    host.addEventListener("click", (e) => e.stopPropagation());
    host.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closePostOverlay(host); pill.focus(); } });
    host.append(pill, pop); el.append(host);
  }
  postOverlayModels.set(el, model);
  if (!postOverlayOutsideBound) {
    postOverlayOutsideBound = true;
    document.addEventListener("click", (e) => { if (activePostOverlay && !activePostOverlay.contains(e.target as Node)) closePostOverlay(activePostOverlay); });
  }
  return host;
}

function paintPostOverlay(el: HTMLElement, model: PostOverlayModel): void {
  const host = ensurePostOverlay(el, model);
  const pill = host.querySelector<HTMLButtonElement>("[data-tbx-pill]"); if (!pill) return;
  const colors = postOverlayColor(model); const label = postOverlayLabel(model);
  const tip = model.done ? "Reply recorded. Open for details." : model.isReplyToOwnPost ? "Direct comment on one of your posts. Open Goobi's reasoning and actions." : model.recommendation?.authorRepeat ? `You replied to @${model.author} ${model.recommendation.authorRepeat.label}; Goobi lowered this spot's scores.` : "Open Goobi's reasoning and actions.";
  // Only mutate values that changed: bodyObs watches these article descendants.
  if (pill.textContent !== label) pill.textContent = label;
  if (pill.title !== tip) pill.title = tip;
  if (pill.style.background !== colors.bg) pill.style.background = colors.bg;
  if (pill.style.color !== colors.fg) pill.style.color = colors.fg;
  if (pill.style.border !== `1px solid ${colors.border}`) pill.style.border = `1px solid ${colors.border}`;
  const opacity = model.kind === "passed" ? "0.72" : "1";
  if (pill.style.opacity !== opacity) pill.style.opacity = opacity;
  if (model.kind === "surfaced") {
    if (!postOriginalBorders.has(el)) postOriginalBorders.set(el, { left: el.style.borderLeft, topRadius: el.style.borderTopLeftRadius, bottomRadius: el.style.borderBottomLeftRadius });
    const left = `3px solid ${colors.border}`;
    if (el.style.borderLeft !== left) el.style.borderLeft = left;
    if (el.style.borderTopLeftRadius !== "4px") el.style.borderTopLeftRadius = "4px";
    if (el.style.borderBottomLeftRadius !== "4px") el.style.borderBottomLeftRadius = "4px";
  }
  if (activePostOverlay === host && host.dataset.tbxDetailsKey !== postOverlayDetailKey(model)) renderPostOverlayDetails(el, host, model);
}

function badge(el: HTMLElement, reason: string, category?: string, score?: number) {
  const info = statusInfo(el); if (!info) return;
  const opp = opps.get(info.id);
  paintPostOverlay(el, { kind: "surfaced", id: info.id, author: info.author, reason, category, score, done: commentedIds.has(info.id), opp, recommendation: opp ? recommendationFor(opp) : undefined, isReplyToOwnPost: opp?.isReplyToOwnPost });
}

/** A quiet explanation affordance on posts the scorer saw but did not surface. */
function addButton(el: HTMLElement) {
  if (el.querySelector("[data-tbx-badge]")) return;
  const info = statusInfo(el); if (!info) return;
  const cached = seen.get(info.id);
  paintPostOverlay(el, { kind: "passed", id: info.id, author: info.author, reason: cached?.reason || "Lower fit for your current priorities", category: cached?.category, score: cached?.score, done: false, isReplyToOwnPost: cached?.isReplyToOwnPost });
}

/** Pin a post into the dock by hand (from "+ Add"), then score it for real so it
 *  gets a proper tag/angle. Manual opps are never pruned, even if they score low. */
async function addManual(el: HTMLElement) {
  const info = statusInfo(el);
  const text = outerText(el);
  if (!info || !text) { toast("Couldn't read that post."); return; }
  clearPostOverlay(el);
  if (opps.has(info.id)) { dockOpen = true; renderDock(); toast("That post is already in your list."); return; }
  const stat = snapStats(el);
  const cached = seen.get(info.id);
  const ownReply = cached?.isReplyToOwnPost || isReplyToOwnPost(el);
  const opp: Opp = {
    id: info.id, author: info.author, text: text.slice(0, 400), manual: true,
    score: cached?.score ?? 0.5, reason: cached?.reason || "Added by you", category: cached?.category,
    anchor: cached?.anchor, replyMove: cached?.replyMove, replyBrief: cached?.replyBrief, risk: cached?.risk,
    context: quotedText(el)?.slice(0, 320), postedAt: stat.postedAt, likes: stat.likes, replies: stat.replies,
    avatar: avatarUrl(el), name: displayName(el), verified: isVerified(el), isReplyToOwnPost: ownReply || undefined,
    source: "feed",
  };
  opps.set(info.id, opp);
  seen.set(info.id, { score: opp.score, reason: opp.reason, category: opp.category, anchor: opp.anchor, replyMove: opp.replyMove, replyBrief: opp.replyBrief, risk: opp.risk, isReplyToOwnPost: opp.isReplyToOwnPost });
  badge(el, opp.reason, opp.category, effectiveScore(opp));
  dockOpen = true; renderDock();
  toast("Added to your reply list — scoring it…");
  // Score it for real (one call, bypasses the per-session cap) to fill in the tag/angle.
  const resp = await send<{ scores?: ScoredPost[]; error?: string }>({ type: "SCORE_POSTS", posts: [{ i: 0, author: info.author, text: opp.text, context: opp.context, meta: ownReply ? "DIRECT COMMENT ON THE USER'S OWN POST" : undefined }] });
  const s = resp?.scores?.[0];
  const cur = opps.get(info.id);
  if (s && cur?.manual) { // keep it pinned; just adopt the real score/tag
    cur.score = s.score; cur.reason = (s.reason || "").split(/\s+/).slice(0, 6).join(" ") || cur.reason; cur.category = catId(s.category) ?? cur.category;
    cur.anchor = s.anchor; cur.replyMove = s.replyMove; cur.replyBrief = s.replyBrief; cur.risk = s.risk;
    seen.set(info.id, { score: cur.score, reason: cur.reason, category: cur.category, anchor: cur.anchor, replyMove: cur.replyMove, replyBrief: cur.replyBrief, risk: cur.risk, isReplyToOwnPost: cur.isReplyToOwnPost });
    if (statusInfo(el)?.id === info.id) badge(el, cur.reason, cur.category, effectiveScore(cur));
    renderDock();
  }
}

/* ---------- draft panel (closed shadow root, CSP-safe) ---------- */

const PANEL_CSS = `
:host { --g-surface:#1d1812; --g-surface-raised:#282018; --g-text:#f7efe2; --g-muted:#b6a892; --g-accent:${ACCENT}; --g-border:rgba(214,154,92,.24); }
:focus-visible { outline:2px solid var(--g-accent); outline-offset:2px; }
.p { width: 340px; max-width: calc(100vw - 36px); background: #1d1812; color: #f3ead9;
     border: .5px solid rgba(214,154,92,.18); border-radius: 14px; padding: 14px;
     font: 13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
     box-shadow: 0 12px 40px rgba(0,0,0,.5); }
.h { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.th { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pav { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
.t { font-weight: 600; } .x { display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; background:none; border:0; border-radius:8px; color:#b6a892; font-size:14px; cursor:pointer; }
.x:hover { background:rgba(214,154,92,.1); color:var(--g-text); }
.ctx { font-size: 12px; color: #b6a892; max-height: 60px; overflow: auto; margin-bottom: 10px;
       border-left: 2px solid rgba(214,154,92,.25); padding-left: 8px; }
.repeat-warn { margin:0 0 10px; padding:8px 9px; border-radius:8px; background:rgba(232,154,60,.12); border:1px solid rgba(232,154,60,.34); color:#f0b66f; font-size:11.5px; line-height:1.4; }
.angles { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.prods { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: -2px 0 10px; }
.plabel { font-size: 10.5px; color: #8c7d68; text-transform: uppercase; letter-spacing: .3px; }
.ang { font: inherit; font-size: 11px; font-weight: 500; border-radius: 999px; padding: 4px 10px; cursor: pointer;
       border: .5px solid rgba(214,154,92,.28); background: #221c15; color: #cbb89c; }
.ang:hover { background: rgba(214,154,92,.10); }
.ang.on { background: ${ACCENT}; color: ${INK}; border-color: transparent; font-weight: 600; }
.load { color: #b6a892; font-size: 12.5px; padding: 6px 0; }
.ta { width: 100%; box-sizing: border-box; background: #221c15; color: #f3ead9;
      border: .5px solid rgba(214,154,92,.18); border-radius: 9px; padding: 9px; font: inherit; resize: vertical; }
.row { display: flex; gap: 8px; margin-top: 10px; }
.b { flex: 1; font: inherit; font-weight: 500; border-radius: 9px; padding: 8px;
     border: .5px solid rgba(214,154,92,.18); background: #221c15; color: #f3ead9; cursor: pointer; }
.b.primary { background: ${ACCENT}; color: ${INK}; border-color: transparent; font-weight: 600; }
.foot { margin-top:9px; font-size:12px; line-height:1.45; color:#b6a892; }
.manual-state { margin:4px 0 10px; padding:10px; border:1px solid rgba(214,154,92,.24); border-radius:10px; background:#221c15; }
.manual-state b { display:block; color:#f3ead9; font-size:13px; }
.manual-state span { display:block; margin-top:4px; color:#b6a892; font-size:12px; line-height:1.45; }
.manual-draft { width:100%; box-sizing:border-box; margin-top:10px; background:#1a1510; color:#d8c9b2; border:.5px solid rgba(214,154,92,.18); border-radius:9px; padding:8px 9px; font:12px/1.4 inherit; resize:none; }
.manual-actions { display:flex; gap:8px; margin-top:10px; }
.manual-actions .b { min-width:0; }
.steer { width: 100%; box-sizing: border-box; margin-top: 10px; background: #1a1510; color: #f3ead9;
         border: .5px solid rgba(214,154,92,.28); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 12px; }
.steer::placeholder { color: #8c7d68; }
.steer:focus { outline: none; border-color: ${ACCENT}; }
@media (max-width: 420px) {
  .p { width:calc(100vw - 24px); max-width:none; padding:12px; border-radius:12px; box-sizing:border-box; }
  .row { flex-wrap:wrap; }
  .b { min-height:38px; }
}
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation:none !important; transition:none !important; } }
`;

let panelHost: HTMLElement | null = null;
let panelRoot: ShadowRoot | null = null;
let panelReturnFocus: HTMLElement | null = null;
/** X registers single-key shortcuts (n=new post, /=search, l=like, …) on `document` and
 *  decides whether to fire them by inspecting the event target. Our inputs live in CLOSED
 *  shadow roots, so a keystroke is retargeted to the host (a plain div) — X doesn't see an
 *  editable field and fires the shortcut, stealing focus mid-type. Key events that bubble
 *  through our host originated in OUR UI, so we can safely stop them from reaching X. Our
 *  own in-shadow handlers (e.g. Enter-to-regenerate) already ran before this bubble point. */
function trapKeys(host: HTMLElement): void {
  for (const ev of ["keydown", "keyup", "keypress"]) host.addEventListener(ev, (e) => e.stopPropagation());
}

function ensurePanel(): ShadowRoot {
  if (panelHost?.isConnected && panelRoot) return panelRoot;
  const shadowActive = dockRoot?.activeElement;
  panelReturnFocus = shadowActive instanceof HTMLElement ? shadowActive : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  panelHost = document.createElement("div");
  Object.assign(panelHost.style, { position: "fixed", bottom: "18px", right: "18px", zIndex: "2147483647" } as Partial<CSSStyleDeclaration>);
  panelRoot = panelHost.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(PANEL_CSS);
  panelRoot.adoptedStyleSheets = [sheet];
  trapKeys(panelHost); // keep X's keyboard shortcuts from hijacking typing in the draft/steer fields
  panelHost.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); dismissPanel(); } });
  document.documentElement.appendChild(panelHost);
  return panelRoot;
}
function dismissPanel(force = false) {
  // Reply completion is intentionally a return-state, not a toast. Keep it on
  // screen until the user explicitly confirms or cancels it.
  if (pendingManualReply && !force) { renderPendingManualReplyCard(); return; }
  panelHost?.remove(); panelHost = null; panelRoot = null;
  if (panelReturnFocus?.isConnected) panelReturnFocus.focus();
  panelReturnFocus = null;
}

let draftOppId: string | null = null;
let draftOppAuthor = "";
/** Cross-session reply-reputation log. X penalties attach to the ACCOUNT (they
 *  suppress reach ongoing, not per-reply), so this persists across navigations +
 *  restarts: times = reply timestamps (rolling hour) for the volume guard,
 *  authors = last-replied-at per handle for the spread guard, drafts = recent
 *  normalized reply texts for the duplicate-reply guard. Persisted after a
 *  successful Like + insert attempt or an explicit copy/open confirmation. */
/** One sent reply's features — the raw material for the "what's working" learning
 *  loop. `outcome` IS written by the daily measure pass (runMeasurePass matches your
 *  posted replies via /user-replies and reads their real engagement); the features are
 *  consumed by learn-stats aggregateAccounts (WHO works) + learnFeatures (WHAT works:
 *  angle, timing, fit-validity). */
interface SentRecord {
  id?: string;           // unique per reply (stable key for playground treats + fed-tracking; old records fall back to String(at))
  at: number;            // when we handed you the reply
  postId?: string;       // the tweet you replied to
  author?: string;       // that tweet's author handle
  score?: number;        // the effectiveScore we gave the opportunity (0..1)
  followers?: number;    // the author's follower count, if known
  ageMs?: number;        // how old the post was when you replied (freshness)
  category?: string;     // opportunity category (promote/value/ask/…)
  angle?: string;        // the drafting angle used
  source?: Opp["source"];// discovery provenance; lets measured cohorts compare Fresh reach honestly
  lane?: ReplyRecommendation["lane"]; // recommendation policy lane at handoff time
  freshReach?: FreshReachEvidence; // observed opening evidence at selection time (optional for old/non-Fresh records)
  growthExperimentId?: string; // top-level strategy active when this reply was handed off
  growthStrategyId?: GrowthStrategyId;
  norm?: string;         // normalized reply text (match + dedup)
  snippet?: string;      // first 80 chars of the reply (match via /user-replies)
  avatar?: string;       // the author's profile picture (so the playground treat wears their face)
  target?: { views?: number; likes?: number; replies?: number }; // the POST's engagement state at reply time — learn "fast-rising vs quiet" per user (cannot be backfilled, so log now)
  confirmedAt?: number;  // actual reply found via RapidAPI, or explicit manual confirmation
  confirmation?: "rapidapi" | "manual";
  outcome?: { at: number; likes?: number; replies?: number; views?: number; reposts?: number; tweetId?: string; authorReplied?: boolean; frozen?: boolean };
}
interface ReplyLog { times: number[]; authors: Record<string, number>; drafts: { norm: string; at: number }[]; daily: Record<string, number>; total: number; sent: SentRecord[]; }
let replyLog: ReplyLog = { times: [], authors: {}, drafts: [], daily: {}, total: 0, sent: [] };
let paceResetAt = 0; // reset only changes Goobi's local pressure baseline; the reply ledger stays intact
let sentSeq = 0; // bump per reply so two in the same millisecond still get distinct ids
const commentedIds = new Set<string>(); // post ids you've replied to — drives the "✓ commented" badge in the feed
const SENT_MAX = 500; // cap the feature log

/** Conservatively UNION two reply logs (a second x.com tab writes this whole object last-write-wins,
 *  so a stale tab could otherwise reset the rolling-hour `times` that drive the ease-off SAFETY guard
 *  — the union guarantees the safety counter can only ever grow toward the true cross-tab total). */
function mergeReplyLog(a: ReplyLog, b: Partial<ReplyLog>): ReplyLog {
  const bSent = Array.isArray(b.sent) ? b.sent : [];
  const byId = new Map<string, SentRecord>();
  const put = (r: SentRecord) => {
    const k = r.id || String(r.at);
    const ex = byId.get(k);
    if (!ex) { byId.set(k, r); return; }
    // Cross-tab writes can discover confirmation/outcomes independently. Merge those facts
    // instead of picking one whole record and accidentally dropping the other tab's proof.
    const confirmedAt = Math.max(ex.confirmedAt ?? 0, r.confirmedAt ?? 0) || undefined;
    const confirmation = ex.confirmation === "rapidapi" || r.confirmation === "rapidapi"
      ? "rapidapi" : ex.confirmation ?? r.confirmation;
    const outcome = mergeReplyOutcomes(ex.outcome, r.outcome);
    byId.set(k, { ...ex, ...r, confirmedAt, confirmation, outcome });
  };
  for (const r of a.sent) put(r);
  for (const r of bSent) put(r);
  let sent = [...byId.values()].sort((x, y) => x.at - y.at);
  if (sent.length > SENT_MAX) sent = sent.slice(-SENT_MAX);

  const times = Array.from(new Set([...a.times, ...(Array.isArray(b.times) ? b.times : [])])).sort((x, y) => x - y).slice(-SENT_MAX);

  const daily: Record<string, number> = { ...a.daily };
  for (const [k, v] of Object.entries(b.daily ?? {})) daily[k] = Math.max(daily[k] ?? 0, Number(v) || 0); // a day's count must never decrease

  const authors: Record<string, number> = { ...a.authors };
  for (const [k, v] of Object.entries(b.authors ?? {})) authors[k] = Math.max(authors[k] ?? 0, Number(v) || 0); // conservative for the repeat-author guard

  const draftMap = new Map<string, { norm: string; at: number }>();
  for (const d of [...a.drafts, ...(Array.isArray(b.drafts) ? b.drafts : [])]) draftMap.set(`${d.norm}@${d.at}`, d);
  const drafts = [...draftMap.values()].sort((x, y) => x.at - y.at).slice(-SENT_MAX);

  const dailySum = Object.values(daily).reduce((s, v) => s + v, 0);
  const total = Math.max(a.total || 0, Number(b.total) || 0, dailySum); // never regress the all-time counter

  return { times, authors, drafts, daily, total, sent };
}

/** Local YYYY-MM-DD for the per-day reply tally ("how many did I send today"). */
function dayKey(ts: number): string {
  const d = new Date(ts); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function repliesToday(): number { return replyLog.daily[dayKey(Date.now())] || 0; }
const HOUR_MS = 3_600_000;
const AUTHOR_REPEAT_TTL = 3 * 24 * HOUR_MS; // "replied recently" window for the spread nudge
const DRAFT_TTL = 24 * HOUR_MS;             // how long a reply counts toward the duplicate guard
const DRAFT_MAX = 50;

/** The current draft request, so the angle chips and Regenerate can re-draft
 *  with the SAME post/context/oppId (and switch only the angle). */
interface DraftReq { author: string; text: string; context?: string; oppId?: string; angle?: string; avatar?: string; products?: ProductItem[]; productIndex?: number; name?: string; steer?: string; isReplyToOwnPost?: boolean; }
let lastDraft: DraftReq | null = null;

/** Authors we've followed (or confirmed already-followed) this session. */
const followed = new Set<string>();
/** Follow pacing: rapid/bulk follows are a classic spam flag, so cap velocity. */
const FOLLOW_MIN_GAP_MS = 20_000; // no rapid-fire follows
const FOLLOW_HOUR_CAP = 15;       // ceiling per rolling hour
let followTimes: number[] = [];

function closeMenu(): void {
  document.querySelector<HTMLElement>('[data-testid="mask"]')?.click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

/** Follow the OUTER post's author via its "•••" menu (the only reliable in-DOM
 *  path on a timeline post). The menu shows "Follow @x" ONLY when not already
 *  following — so this can only follow, never unfollow. User initiation plus a local
 *  min-gap/hourly cap reduces rapid repeated actions; it is not an X safety guarantee. */
async function followAuthor(el: HTMLElement | null): Promise<"followed" | "already" | "failed" | "paced"> {
  if (!el?.isConnected) return "failed";
  const now = Date.now();
  followTimes = followTimes.filter((t) => now - t < 3_600_000);
  // Jitter the floor so consecutive follows aren't a clockwork interval.
  if ((followTimes.length && now - followTimes[followTimes.length - 1] < jitterGap(FOLLOW_MIN_GAP_MS)) || followTimes.length >= FOLLOW_HOUR_CAP) return "paced";
  const caret = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="caret"]')).find((c) => !c.closest('[role="link"]'));
  if (!caret) return "failed";
  caret.click();
  const menu = await waitFor('[role="menu"]', 1500);
  if (!menu) return "failed";
  await sleep(humanDelayMs("menu")); // a beat to "read" the menu before clicking
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const follow = items.find((it) => /^follow\b/i.test(it.textContent?.trim() || ""));
  if (follow) { follow.click(); followTimes.push(Date.now()); return "followed"; }
  const already = items.some((it) => /^unfollow\b/i.test(it.textContent?.trim() || ""));
  closeMenu();
  return already ? "already" : "failed";
}

/** Locate a post by status id. Falls back to matching its first 60 chars ONLY
 *  for an element whose status id can't be read yet (its permalink anchor isn't
 *  painted). An element with a DIFFERENT extractable id is a different tweet and
 *  is never matched, so we can never act on a same-author lookalike. Off-page
 *  opps (e.g. search-discovered, whose id is not in the DOM) find nothing, so
 *  Like + insert degrades to the exact-post review handoff when the post is not rendered. Pass no text to
 *  force a strict id-only lookup. */
function findPost(id: string, text?: string): HTMLElement | null {
  let byText: HTMLElement | null = null;
  const needle = text?.slice(0, 60);
  // X's signed-in timeline currently marks posts with data-testid="tweet", while
  // its newer public/status surface exposes plain <article> nodes. The canonical
  // status permalink remains the durable identity contract on both surfaces.
  for (const a of document.querySelectorAll<HTMLElement>("article")) {
    const info = statusInfo(a);
    if (info?.id === id) return a;  // id match wins
    if (info) continue;             // a different, identifiable tweet — never a fallback target
    if (needle && !byText && outerText(a).startsWith(needle)) byText = a;
  }
  return byText;
}

/** Repaint one rendered post after its reply status changes. */
function repaintReplyPost(id: string): void {
  const el = findPost(id); if (!el) return;
  const cached = seen.get(id);
  const opp = opps.get(id);
  if (opp || el.querySelector("[data-tbx-badge]")) badge(el, opp?.reason || cached?.reason || "Reply opportunity", opp?.category || cached?.category, opp?.score ?? cached?.score);
  else addButton(el);
}

function waitFor(sel: string, ms: number): Promise<HTMLElement | null> {
  return new Promise((res) => {
    const now = document.querySelector<HTMLElement>(sel);
    if (now) return res(now);
    const obs = new MutationObserver(() => {
      const f = document.querySelector<HTMLElement>(sel);
      if (f) { clearTimeout(t); obs.disconnect(); res(f); }
    });
    const t = setTimeout(() => { obs.disconnect(); res(document.querySelector<HTMLElement>(sel)); }, ms);
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

function waitForMatch(find: () => HTMLElement | null, ms: number): Promise<HTMLElement | null> {
  return new Promise((res) => {
    const now = find();
    if (now) return res(now);
    const obs = new MutationObserver(() => {
      const found = find();
      if (found) { clearTimeout(t); obs.disconnect(); res(found); }
    });
    const t = setTimeout(() => { obs.disconnect(); res(find()); }, ms);
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve X's real contenteditable from its tweetTextarea wrapper. */
function composerEditable(node: HTMLElement): HTMLElement {
  if (node.getAttribute("contenteditable") === "true") return node;
  return node.querySelector<HTMLElement>('[contenteditable="true"]') || node;
}

function composerText(node: HTMLElement): string {
  return (node.textContent || "").replace(/​/g, "").replace(/\s+/g, " ").trim();
}

function replyButtonIn(postEl: HTMLElement): HTMLElement | null {
  const candidates = postEl.querySelectorAll<HTMLElement>('[data-testid="reply"], button[aria-label="Reply"], [role="button"][aria-label="Reply"]');
  const semantic = Array.from(candidates).find((button) => !button.closest('[role="link"]'));
  if (semantic) return semantic;
  // Current X comment-bubble glyph supplied by the live UI. Use it only as a
  // tertiary fallback, scoped to the already ID-matched article, and click its
  // interactive parent rather than the SVG/path itself.
  const bubblePath = Array.from(postEl.querySelectorAll<SVGPathElement>("svg path"))
    .find((path) => isReplyBubblePath(path.getAttribute("d")));
  return bubblePath?.closest<HTMLElement>('button,[role="button"]') || null;
}

function composerIn(root: ParentNode): HTMLElement | null {
  const wrapper = root.querySelector<HTMLElement>('[data-testid^="tweetTextarea_"]');
  if (wrapper) return wrapper;
  return root.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]');
}

function dialogReplyComposer(): HTMLElement | null {
  for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
    const composer = composerIn(dialog);
    if (composer) return composer;
  }
  return null;
}

function pageReplyComposer(): HTMLElement | null {
  const main = document.querySelector<HTMLElement>("main");
  return main ? composerIn(main) : null;
}

function placeComposerCaretAtEnd(node: HTMLElement): void {
  try {
    const range = document.createRange(); range.selectNodeContents(node); range.collapse(false);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  } catch { /* best-effort */ }
}

/** Fill one empty X reply composer in one verified operation. This does not type
 *  word-by-word, submit the reply, or overwrite text already present. */
async function fillReplyComposer(node: HTMLElement, text: string): Promise<"ok" | "occupied" | "blocked"> {
  const editor = composerEditable(node);
  const want = text.replace(/​/g, "").replace(/\s+/g, " ").trim();
  const complete = () => want.length > 0 && composerText(editor) === want;
  if (complete()) return "ok";
  if (composerText(editor)) return "occupied";

  const clearAttempt = async () => {
    try {
      editor.focus();
      const range = document.createRange(); range.selectNodeContents(editor);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      document.execCommand("delete", false);
      await sleep(30);
    } catch { /* best-effort */ }
  };
  const methods = [
    () => document.execCommand("insertText", false, text),
    () => {
      try {
        const data = new DataTransfer(); data.setData("text/plain", text);
        editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      } catch { /* try beforeinput next */ }
    },
    () => {
      editor.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
      editor.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
    },
  ];

  for (const method of methods) {
    if (composerText(editor)) await clearAttempt();
    if (composerText(editor)) return "blocked";
    editor.focus(); placeComposerCaretAtEnd(editor); method();
    for (let i = 0; i < 12; i++) { if (complete()) return "ok"; await sleep(40); }
  }
  return complete() ? "ok" : "blocked";
}

/** Open only the selected post's reply composer and fill it. Never submits. */
async function insertReplyIntoX(text: string, postEl: HTMLElement | null): Promise<"ok" | "no-composer" | "occupied" | "blocked"> {
  const existingDialog = dialogReplyComposer();
  if (existingDialog) return "occupied"; // do not risk filling an unrelated composer
  if (!postEl?.isConnected) return "no-composer";
  postEl.scrollIntoView({ block: "center" });
  const reply = replyButtonIn(postEl);
  if (!reply) return "no-composer";
  reply.click();
  const editor = await waitForMatch(
    () => dialogReplyComposer() || (location.pathname.includes("/status/") ? pageReplyComposer() : null),
    3500,
  );
  if (!editor) return "no-composer";
  return fillReplyComposer(editor, text);
}

const likedPostIds = new Set<string>();

/** Like only the selected outer post. The `like` test id disappears once liked,
 *  so this can never toggle an existing like off. */
function likeSelectedPost(id: string | null, postEl: HTMLElement | null): boolean {
  if (id && likedPostIds.has(id)) return true;
  const target = id ? findPost(id) : (postEl?.isConnected ? postEl : null);
  if (!target?.isConnected) return false;
  const unlike = Array.from(target.querySelectorAll<HTMLElement>('[data-testid="unlike"]')).find((candidate) => !candidate.closest('[role="link"]'));
  if (unlike) { if (id) likedPostIds.add(id); return true; }
  const buttons = Array.from(target.querySelectorAll<HTMLElement>('[data-testid="like"]'));
  const button = buttons.find((candidate) => !candidate.closest('[role="link"]')) || buttons[0];
  if (!button) return false;
  button.click();
  if (id) likedPostIds.add(id);
  return true;
}

let inserting = false;
interface PendingManualReply {
  text: string;
  opp?: Opp;
  angle?: string;
  author: string;
  handoff: ReplyHandoff;
  copied: boolean;
  opened: boolean;
  status: "opening" | "ok" | "no-composer" | "occupied" | "blocked";
}
let pendingManualReply: PendingManualReply | undefined;

function handoffToken(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}.${Math.random().toString(36).slice(2)}`; }
}

function buildReplyHandoff(text: string, opp?: Opp): ReplyHandoff | null {
  const postId = opp?.id ?? draftOppId ?? "";
  if (!/^\d+$/.test(postId)) return null;
  return {
    version: 1,
    token: handoffToken(),
    postId,
    author: (opp?.author ?? draftOppAuthor).replace(/^@+/, ""),
    text,
    createdAt: Date.now(),
  };
}

async function copyReplyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  // Clipboard permission can disappear after X's composer timeout. Retain a
  // synchronous copy path so the fallback still does useful work.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    Object.assign(ta.style, { position: "fixed", left: "-9999px", top: "0" } as Partial<CSSStyleDeclaration>);
    document.documentElement.appendChild(ta);
    ta.select();
    const copied = document.execCommand("copy");
    ta.remove();
    return copied;
  } catch { return false; }
}

/** Copy immediately from the user's click, then ask the service worker to store
 *  the one-shot draft and open the exact X status tab. The destination content
 *  script owns the reply-icon click + verified composer fill. */
async function copyReplyAndOpenPost(handoff: ReplyHandoff): Promise<{ copied: boolean; opened: boolean }> {
  const copied = copyReplyText(handoff.text);
  const opened = send<{ ok?: boolean }>({ type: "OPEN_REPLY_HANDOFF", handoff });
  const [didCopy, result] = await Promise.all([copied, opened]);
  return { copied: didCopy, opened: result?.ok === true };
}

async function copyAndOpenPendingReplyPost(): Promise<void> {
  const pending = pendingManualReply;
  if (!pending) return;
  pending.handoff = { ...pending.handoff, token: handoffToken(), createdAt: Date.now() };
  pending.status = "opening";
  pending.opened = false;
  renderPendingManualReplyCard();
  const result = await copyReplyAndOpenPost(pending.handoff);
  if (pendingManualReply !== pending) return;
  pending.copied = result.copied;
  pending.opened = result.opened;
  if (!result.opened && pending.status === "opening") pending.status = "no-composer";
  renderPendingManualReplyCard();
  toast(result.opened
    ? "Opened the exact X post. Goobi is activating Reply and prefilling the draft."
    : "X could not be opened. Your draft remains available in Goobi.");
}

function cancelPendingManualReply(): void {
  const pending = pendingManualReply;
  if (!pending) return;
  pendingManualReply = undefined;
  dismissPanel();
  toast("Reply handoff cancelled — nothing was counted.");
}

function markPendingManualReplyPosted(): void {
  const pending = pendingManualReply;
  if (!pending) return;
  // Clear first: even a double click or re-entrant render can record this handoff
  // only once. The normal record/nudge path owns every tally and safety update.
  pendingManualReply = undefined;
  const warn = recordReplyAndNudge(pending.text, pending.opp, pending.angle, pending.author, "manual");
  if (pending.handoff.postId) repaintReplyPost(pending.handoff.postId);
  dismissPanel();
  toast(warn || "Reply marked as posted.");
}

function renderPendingManualReplyCard(): void {
  const pending = pendingManualReply;
  if (!pending) return;
  const root = ensurePanel();
  root.replaceChildren();
  const p = document.createElement("div"); p.className = "p";
  p.setAttribute("role", "dialog"); p.setAttribute("aria-modal", "false"); p.setAttribute("aria-labelledby", "goobi-manual-title");
  const h = document.createElement("div"); h.className = "h";
  const title = document.createElement("div"); title.className = "t"; title.id = "goobi-manual-title"; title.textContent = "Finish your reply on X";
  h.append(title);
  const state = document.createElement("div"); state.className = "manual-state";
  const status = document.createElement("b");
  status.textContent = pending.status === "ok"
    ? "X reply box ready · draft prefilled"
    : pending.status === "opening"
      ? "Opening the post · preparing Reply"
      : pending.status === "occupied"
        ? "X already has a reply draft open"
        : "X post opened · paste the draft if needed";
  const help = document.createElement("span");
  help.textContent = pending.status === "ok"
    ? "Goobi opened the exact post, clicked its Reply icon, and verified the draft in X's input. Review or edit it, post it yourself, then come back here."
    : pending.status === "opening"
      ? "Goobi is waiting for the exact post to render, then it will click Reply and verify the draft landed. Nothing is submitted automatically."
      : pending.copied
        ? "Goobi did not overwrite X's composer. The draft is on your clipboard; paste it into the reply box, review it, and post it yourself."
        : "Goobi did not overwrite X's composer and clipboard access was unavailable. Copy the draft below, review it in X, and post it yourself.";
  const draft = document.createElement("textarea"); draft.className = "manual-draft"; draft.rows = 4; draft.readOnly = true; draft.value = pending.text; draft.setAttribute("aria-label", "Reply draft to copy");
  state.append(status, help, draft);
  const actions = document.createElement("div"); actions.className = "manual-actions";
  const open = document.createElement("button"); open.className = "b"; open.textContent = "Reopen exact post ↗"; open.onclick = () => void copyAndOpenPendingReplyPost();
  const mark = document.createElement("button"); mark.className = "b primary"; mark.textContent = "Mark as posted"; mark.onclick = markPendingManualReplyPosted;
  const cancel = document.createElement("button"); cancel.className = "b"; cancel.textContent = "Cancel"; cancel.onclick = cancelPendingManualReply;
  actions.append(open, mark, cancel);
  const foot = document.createElement("div"); foot.className = "foot"; foot.textContent = "Only Mark as posted updates reply totals, pacing, streaks, and learning.";
  p.append(h, state, actions, foot);
  root.append(p);
  requestAnimationFrame(() => { if (panelRoot === root) open.focus(); });
}

let fulfillingReplyHandoff = false;

/** On the exact status tab opened by the service worker, claim the one-shot
 *  handoff, click that article's Reply control, and verify the draft text landed.
 *  A failure never overwrites an occupied composer and never submits anything. */
async function maybeFulfillReplyHandoff(): Promise<void> {
  const postId = statusIdFromPath(location.pathname);
  if (!postId || fulfillingReplyHandoff || invalidated) return;
  fulfillingReplyHandoff = true;
  try {
    const raw = await getLocal(CONFIG.X_REPLY_HANDOFF_KEY);
    const candidates = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
      .map((value) => validReplyHandoff(value))
      .filter((value): value is ReplyHandoff => !!value);
    if (!candidates.some((handoff) => handoffMatchesPath(handoff, location.pathname))) return;
    const postEl = await waitForMatch(() => findPost(postId), 12_000);
    if (!postEl || invalidated) return; // leave the unclaimed handoff available for a reload/retry
    const claimed = await send<{ handoff?: ReplyHandoff | null }>({ type: "CLAIM_REPLY_HANDOFF", postId });
    const handoff = claimed?.handoff;
    if (!handoff || invalidated) return;
    const status = await insertReplyIntoX(handoff.text, postEl);
    await send({ type: "REPLY_HANDOFF_RESULT", handoff, status });
    toast(status === "ok"
      ? "Reply opened and draft prefilled. Review it, then post on X when ready."
      : status === "occupied"
        ? "X already has a reply draft open, so Goobi did not overwrite it. Your new draft was copied before this tab opened."
        : "Goobi opened the post but could not safely fill X's reply box. Your draft was copied before this tab opened.");
  } finally {
    fulfillingReplyHandoff = false;
  }
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type !== "REPLY_HANDOFF_STATUS") return;
  const pending = pendingManualReply;
  if (!pending || pending.handoff.token !== msg.token) return;
  pending.status = msg.status;
  renderPendingManualReplyCard();
  if (msg.status === "ok") toast("X's reply box is prefilled and ready for your review.");
});

/** Record a confirmed reply in the persisted reputation log and return the single
 *  most important nudge (duplicate-reply > adaptive pace > repeat-author), or null.
 *  Pattern-aware + cross-session, because X's penalties attach to the account. */
/** Bump today's "replies sent" tally + the all-time total; trim old days. */
function bumpDaily(now: number): void {
  const dk = dayKey(now);
  replyLog.daily[dk] = (replyLog.daily[dk] || 0) + 1;
  replyLog.total = (replyLog.total || 0) + 1;
  const cut = dayKey(now - 35 * 24 * HOUR_MS); // keep ~35 days of per-day history
  for (const k of Object.keys(replyLog.daily)) if (k < cut) delete replyLog.daily[k];
}

/** Append a feature record for the reply we just helped send — the raw material the
 *  "what's working" loop correlates with outcomes: the daily measure-pass fills SentRecord.outcome,
 *  learnFeatures/aggregateAccounts turn it into per-angle/per-account signal, and (behind
 *  learnLoopOn) accountRankMultipliers + learnedBestAngle feed it back into ranking + drafting. */
function logSentReply(now: number, text: string, opp?: Opp, angle?: string, confirmation?: "rapidapi" | "manual"): void {
  const gx = activeGrowthExperiment(growthStore);
  const recommendation = opp ? recommendationFor(opp, now) : undefined;
  const rec: SentRecord = {
    id: `${now}.${sentSeq++}`,
    at: now,
    postId: opp?.id ?? draftOppId ?? undefined,
    author: (opp?.author ?? draftOppAuthor) || undefined,
    score: recommendation?.priority,
    followers: opp ? knownFollowers(opp) : undefined,
    ageMs: opp?.postedAt ? Math.max(0, now - opp.postedAt) : undefined,
    category: opp?.category,
    angle: angle || opp?.category,
    source: opp?.source,
    lane: recommendation?.lane,
    freshReach: opp?.freshReach ? { ...opp.freshReach, contentFit: opp.score } : undefined,
    growthExperimentId: gx?.id,
    growthStrategyId: gx?.strategyId,
    norm: normalizeReply(text) || undefined,
    snippet: text.slice(0, 80),
    avatar: opp?.avatar,
    target: opp && (opp.views != null || opp.likes != null || opp.replies != null) ? { views: opp.views, likes: opp.likes, replies: opp.replies } : undefined,
    confirmedAt: confirmation ? now : undefined,
    confirmation,
  };
  replyLog.sent.push(rec);
  if (rec.postId) commentedIds.add(rec.postId); // mark this post as commented → "✓" badge in the feed
  if (replyLog.sent.length > SENT_MAX) replyLog.sent = replyLog.sent.slice(-SENT_MAX);
}

/** Record one assisted reply attempt after a successful composer fill or explicit
 *  copy/open confirmation: count it, log its features, update author recency,
 *  persist, and refresh the UI. */
function recordSentReply(text: string, opp?: Opp, angle?: string, now: number = Date.now(), confirmation?: "rapidapi" | "manual"): void {
  replyLog.times = replyLog.times.filter((t) => now - t < HOUR_MS);
  replyLog.times.push(now); // every confirmed reply enters the adaptive rolling pace ledger
  const firstToday = (replyLog.daily[dayKey(now)] || 0) === 0;
  bumpDaily(now);
  logSentReply(now, text, opp, angle, confirmation);
  const confirmedAuthor = (opp?.author ?? draftOppAuthor).replace(/^@+/, "").toLowerCase();
  if (confirmedAuthor) replyLog.authors[confirmedAuthor] = Math.max(replyLog.authors[confirmedAuthor] ?? 0, now);
  const pid = opp?.id ?? draftOppId; // you replied → drop it from the dock (the feed badge handles the green "✓")
  if (pid) opps.delete(pid);
  touchGoobi();
  // Goobi beams when you reply — but NEVER when you're past the line (honest mirror:
  // he refuses to celebrate going too fast; at ease-off he stays woozy instead).
  // The first reply of a day that extends a streak earns a bigger 'cheer' (tada).
  if (currentReplyPace(now).level !== "easeoff") {
    const streak = replyStreak();
    if (firstToday && streak >= 2) goobiReactLove(`${streak}-day streak!`, "love that you keep showing up", 3800);
    else goobiReactLove("Love it!", "that's the good stuff", 3200);
  }
  safeSet({ [CONFIG.X_REPLY_LOG_KEY]: replyLog });
  if (text.trim()) scheduleReplyVerification(); // manual confirms posting; RapidAPI still verifies the tweet + measures its outcome after the timeline updates
  renderDock(); // update "N replies sent today" immediately
  requestScan(); // flip this post's in-feed badge to the green "✓ Commented" call-out
}

function recordReplyAndNudge(text: string, opp?: Opp, angle?: string, replyAuthor?: string, confirmation?: "rapidapi" | "manual"): string | null {
  const now = Date.now();
  const displayAuthor = (replyAuthor || opp?.author || draftOppAuthor).replace(/^@+/, "");
  const author = displayAuthor.toLowerCase();
  const last = author ? replyLog.authors[author] : undefined;
  const repeat = last != null && now - last < AUTHOR_REPEAT_TTL;
  const norm = normalizeReply(text);
  const recentNorms = replyLog.drafts.filter((d) => now - d.at < DRAFT_TTL).map((d) => d.norm);
  const duplicate = isDuplicateReply(norm, recentNorms);
  if (author) replyLog.authors[author] = now;
  if (norm) replyLog.drafts.push({ norm, at: now });
  replyLog.drafts = replyLog.drafts.filter((d) => now - d.at < DRAFT_TTL).slice(-DRAFT_MAX);
  recordSentReply(text, opp, angle, now, confirmation); // pushes this reply onto the adaptive pace ledger
  const pace = currentReplyPace(now);
  return pickReplyNudge({ duplicate, repliesThisHour: pace.repliesThisHour, pacePressure: pace.pressure, repeatAuthor: repeat ? displayAuthor : null });
}

async function startCopyOpenHandoff(text: string, opp?: Opp, angle?: string): Promise<void> {
  const handoff = buildReplyHandoff(text, opp);
  if (!handoff) {
    const copied = await copyReplyText(text);
    toast(copied
      ? "This opportunity no longer has a valid X post ID. The draft was copied instead."
      : "This opportunity no longer has a valid X post ID. Copy the draft from Goobi instead.");
    return;
  }
  const pending: PendingManualReply = { text, opp, angle, author: opp?.author || draftOppAuthor, handoff, copied: false, opened: false, status: "opening" };
  pendingManualReply = pending;
  renderPendingManualReplyCard();
  const result = await copyReplyAndOpenPost(handoff);
  if (pendingManualReply !== pending) return;
  pending.copied = result.copied;
  pending.opened = result.opened;
  if (!result.opened && pending.status === "opening") pending.status = "no-composer";
  renderPendingManualReplyCard();
  toast(result.opened
    ? "Opened the exact X post. Goobi is activating Reply and prefilling the draft."
    : "X could not be opened. Your draft remains available in Goobi.");
}

/** Prefer X's already-rendered UI. If the exact post is on this page, click its
 *  comment control and fill the local composer without opening or focusing any
 *  other tab. The caller resolves the exact article synchronously so an off-page
 *  fallback retains the original click gesture. */
async function startVisiblePostReview(text: string, postEl: HTMLElement, opp?: Opp, angle?: string): Promise<void> {
  const handoff = buildReplyHandoff(text, opp);
  if (!handoff) return;
  const copied = copyReplyText(text); // fallback starts inside the user gesture; success still uses X's input directly
  const status = await insertReplyIntoX(text, postEl);
  const pending: PendingManualReply = {
    text,
    opp,
    angle,
    author: opp?.author || draftOppAuthor,
    handoff,
    copied: await copied,
    opened: true,
    status,
  };
  pendingManualReply = pending;
  renderPendingManualReplyCard();
  toast(status === "ok"
    ? "Clicked Reply on this post and prefilled the draft. Review it in X before posting."
    : status === "occupied"
      ? "X already has a reply draft open, so Goobi did not overwrite it."
      : "Goobi found this post but could not safely fill its reply box. The draft is ready to paste.");
}

async function handoffReply(text: string): Promise<void> {
  if (inserting) return;
  if (!text.replace(/​/g, "").trim()) { toast("The draft is empty — nothing to copy."); return; }
  inserting = true;
  try {
    const opp = draftOppId ? opps.get(draftOppId) : undefined;
    const angle = lastDraft?.angle;
    const postEl = draftOppId ? findPost(draftOppId, opp?.source === "feed" ? opp.text : undefined) : null;
    if (postEl) await startVisiblePostReview(text, postEl, opp, angle);
    else await startCopyOpenHandoff(text, opp, angle);
  } finally {
    inserting = false;
  }
}

async function likeAndInsertReply(text: string): Promise<void> {
  if (inserting) return;
  if (!text.replace(/​/g, "").trim()) { toast("The draft is empty — nothing to insert."); return; }
  inserting = true;
  try {
    const opp = draftOppId ? opps.get(draftOppId) : undefined;
    const angle = lastDraft?.angle;
    const postEl = draftOppId ? findPost(draftOppId, opp?.source === "feed" ? opp.text : undefined) : null;
    const result = await insertReplyIntoX(text, postEl);
    if (result === "ok") {
      const liked = draftOppId ? likeSelectedPost(draftOppId, postEl) : false;
      const postId = draftOppId ?? opp?.id;
      const warn = recordReplyAndNudge(text, opp, angle);
      if (postId) repaintReplyPost(postId);
      dismissPanel(true);
      toast(warn || (liked
        ? "Post liked and reply inserted. Review it, then submit on X."
        : "Reply inserted. Review it, then submit on X."));
      return;
    }
    const reason = result === "occupied"
      ? "An X composer is already open or contains text."
      : result === "no-composer" ? "That post is not available in this tab." : "X blocked the composer fill.";
    toast(`${reason} Switching to the exact-post review flow.`);
    await startCopyOpenHandoff(text, opp, angle);
  } finally {
    inserting = false;
  }
}

function runReplyDraftAction(text: string): Promise<void> {
  const opp = draftOppId ? opps.get(draftOppId) : undefined;
  // Keyword-discovered cold opportunities always use X's official, manual review surface.
  return xReplyInsertOn && opp?.source !== "fresh-reach" ? likeAndInsertReply(text) : handoffReply(text);
}

async function draftFor(req: DraftReq) {
  if (pendingManualReply) { renderPendingManualReplyCard(); toast("Finish or cancel the reply waiting for confirmation first."); return; }
  const { author, text, context, oppId, angle, avatar, name, steer, isReplyToOwnPost: reqOwnReply } = req;
  draftOppId = oppId ?? null;
  draftOppAuthor = author;
  // The picker lists ALL products when promoting (choose any); default-select the
  // opp's best-fit product, else the user's default, else the first.
  const candidates = angle === "promote" && xProducts.length ? xProducts : undefined;
  let productIndex = req.productIndex;
  // Re-resolve when unset OR out of range (e.g. a product was deleted/reordered
  // after the index was chosen) so it never falls through to the all-products path.
  if (candidates && (productIndex == null || productIndex < 0 || productIndex >= candidates.length)) {
    const preferred = req.products?.[0]?.name;
    const pi = preferred ? candidates.findIndex((p) => p.name === preferred) : -1;
    productIndex = pi >= 0 ? pi : defaultProductIndex(candidates);
  }
  productIndex = productIndex ?? 0;
  req = { ...req, productIndex };
  lastDraft = req;
  // The product to weave in: the chosen one when promoting, else all (drafter picks).
  const product = candidates ? productContext(candidates[productIndex]) : productContext(undefined);
  const ui = { angle, avatar, name, products: candidates, productIndex, steer };
  const root = ensurePanel();
  paintPanel(root, author, text, { loading: true, ...ui });
  goobiDrafting = true; refreshGoobi(); // Goobi thinks while Claude writes the reply
  // Ground the drafter in what we already know about this opp (specificity = ranked variable).
  const dOpp = oppId ? opps.get(oppId) : undefined;
  const ownReply = dOpp?.isReplyToOwnPost || reqOwnReply;
  const authorLine = dOpp ? [
    `@${dOpp.author}`,
    knownFollowers(dOpp) != null ? `~${fmtCount(knownFollowers(dOpp))} followers` : "",
    builderTierFor(dOpp) === 2 ? "a two-way peer in the user's niche" : builderTierFor(dOpp) === 1 ? "a builder/community person" : "",
  ].filter(Boolean).join(" · ") : undefined;
  const threadLine = ownReply
    ? "This is a direct comment on one of the user's own posts. Reply as the original poster continuing a warm inbound conversation, not as cold outreach."
    : undefined;
  const liveFresh = dOpp ? currentFreshReach(dOpp) : null;
  const opportunityLine = dOpp?.source === "fresh-reach"
    ? liveFresh
      ? `Goobi currently classifies this as ${freshReachKindLabel(liveFresh.kind)} from these public observations: ${freshReachMetricFacts(dOpp, liveFresh).join(", ")}. These are product heuristics, not an X ranking guarantee. Write one self contained contribution for surrounding readers, not flattery for the author. Never mention targeting, timing, account size, Premium, a blue check, reach, views, engagement, or impressions in the reply.`
      : "This post was found by Fresh reach but has since left Goobi's strict timing, competition, or audience window. Do not imply urgency or manufacture a reason to reply. Draft only a specific, self contained contribution that remains worthwhile for surrounding readers."
    : undefined;
  const resp = await send<{ reply?: string; error?: string }>({ type: "DRAFT_REPLY", author, text, context, angle, product, steer, reason: dOpp?.reason, category: dOpp?.category, anchor: dOpp?.anchor, replyBrief: dOpp?.replyBrief, authorLine, threadLine, opportunityLine });
  goobiDrafting = false; refreshGoobi();
  if (resp?.error === "no-key") paintPanel(root, author, text, { note: "Add your Anthropic key in the Goobi panel to draft replies.", ...ui });
  else if (!resp || resp.error) paintPanel(root, author, text, { note: resp?.error ? `Couldn't draft: ${friendlyErr(resp.error)}` : "Couldn't draft — the background didn't respond. Try again.", ...ui });
  else paintPanel(root, author, text, { draft: resp.reply ?? "", ...ui });
}

/** The angle chips. Clicking re-drafts with that steer; clicking the active one
 *  toggles it back off (neutral). Reuses lastDraft so post/context are kept. */
function angleRow(active?: string): HTMLElement {
  const row = document.createElement("div"); row.className = "angles";
  // The learner's SOFT steer: star the angle whose replies measurably out-earn the user's average.
  // Display-only — the model's per-post category still drives the default (fit is post-specific).
  const fl = learnFeatures(replyLog.sent, Date.now());
  for (const a of REPLY_ANGLES) {
    const c = document.createElement("button");
    c.className = "ang" + (active === a.id ? " on" : "");
    const starred = fl.bestAngle === a.id;
    c.textContent = starred ? `\u2605 ${a.label}` : a.label;
    const starWhy = starred ? ` \u2605 Your measured-best angle: these replies earned ${fl.angles[0].rel.toFixed(1)}\u00D7 your average engagement (n=${fl.angles[0].n}, reach-normalized). Correlation, not causation.\n` : "";
    c.title = starWhy + a.directive;
    c.onclick = () => {
      const d = lastDraft;
      if (!d) return;
      void draftFor({ ...d, angle: active === a.id ? undefined : a.id });
    };
    row.appendChild(c);
  }
  return row;
}

/** Product picker, shown when the active angle is Promote: pick which product to plug. */
function productRow(candidates: ProductItem[], selected: number): HTMLElement {
  const row = document.createElement("div"); row.className = "prods";
  const lbl = document.createElement("span"); lbl.className = "plabel"; lbl.textContent = "Promote:"; row.append(lbl);
  candidates.forEach((p, i) => {
    const c = document.createElement("button");
    c.className = "ang" + (i === selected ? " on" : "");
    c.textContent = p.name;
    c.title = p.blurb || p.name;
    c.onclick = () => { const d = lastDraft; if (d) void draftFor({ ...d, productIndex: i }); };
    row.appendChild(c);
  });
  return row;
}

function openDraftFromEl(el: HTMLElement) {
  const info = statusInfo(el);
  const meta = info ? (opps.get(info.id) ?? seen.get(info.id)) : undefined;
  void draftFor({ author: info?.author || "this post", text: outerText(el), context: quotedText(el), oppId: info?.id, angle: initialAngle(meta?.category), avatar: avatarUrl(el), products: meta?.products, name: displayName(el), isReplyToOwnPost: meta?.isReplyToOwnPost || isReplyToOwnPost(el) });
}

function paintPanel(root: ShadowRoot, author: string, text: string, opts: { loading?: boolean; note?: string; draft?: string; angle?: string; avatar?: string; name?: string; products?: ProductItem[]; productIndex?: number; steer?: string }) {
  root.replaceChildren();
  const p = document.createElement("div"); p.className = "p";
  p.setAttribute("role", "dialog"); p.setAttribute("aria-modal", "false"); p.setAttribute("aria-labelledby", "goobi-draft-title");
  const h = document.createElement("div"); h.className = "h";
  const th = document.createElement("div"); th.className = "th";
  if (opts.avatar) { const av = document.createElement("img"); av.className = "pav"; av.src = opts.avatar; av.alt = ""; av.referrerPolicy = "no-referrer"; av.onerror = () => av.remove(); th.append(av); }
  const t = document.createElement("div"); t.className = "t"; t.id = "goobi-draft-title"; t.textContent = `Reply to ${opts.name || "@" + author}`;
  th.append(t);
  const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.setAttribute("aria-label", "Close draft panel"); x.title = "Close (Escape)"; x.onclick = () => dismissPanel();
  h.append(th, x);
  const ctx = document.createElement("div"); ctx.className = "ctx"; ctx.textContent = text;
  p.append(h, ctx);
  const repeatState = repeatAuthorWarning({
    authorHandle: author,
    recentAuthorReplies: recentRepliesTo(author, Date.now()),
    lastAuthorReplyAt: replyLog.authors[author.replace(/^@+/, "").toLowerCase()],
  }, Date.now());
  if (repeatState) {
    const repeat = document.createElement("div"); repeat.className = "repeat-warn";
    repeat.textContent = `You replied to @${author.replace(/^@+/, "")} ${repeatState.label}. Goobi lowered this spot's score to encourage account spread. Continue only for a real ongoing conversation.`;
    p.append(repeat);
  }
  p.append(angleRow(opts.angle));
  if (opts.angle === "promote" && opts.products && opts.products.length) p.append(productRow(opts.products, opts.productIndex ?? 0));
  if (opts.loading) {
    const l = document.createElement("div"); l.className = "load"; l.textContent = "Drafting in your voice…"; p.append(l);
  } else if (opts.note) {
    const n = document.createElement("div"); n.className = "load"; n.textContent = opts.note; p.append(n);
  } else {
    const ta = document.createElement("textarea"); ta.className = "ta"; ta.rows = 5; ta.value = opts.draft ?? ""; ta.setAttribute("aria-label", "Reply draft");
    const manualReview = !xReplyInsertOn || (draftOppId ? opps.get(draftOppId)?.source === "fresh-reach" : false);
    const insert = document.createElement("button"); insert.className = "b primary"; insert.textContent = manualReview ? "Review & reply on X ↗" : "Like + insert reply in X";
    insert.title = !manualReview
      ? "Like the selected post and fill X's reply box; you review and submit it"
      : "Use this post's Reply control in place and prefill the draft; only off-page results open their exact status page";
    insert.style.width = "100%"; insert.style.marginTop = "10px"; insert.style.boxSizing = "border-box";
    insert.onclick = () => void runReplyDraftAction(ta.value);
    // Steering: type how to nudge the reply, then Regenerate (or Enter) re-drafts with it.
    const steer = document.createElement("input"); steer.className = "steer"; steer.type = "text";
    steer.placeholder = "Steer it — e.g. punchier, ask a question, less formal…";
    steer.value = opts.steer ?? "";
    const row = document.createElement("div"); row.className = "row";
    const copy = document.createElement("button"); copy.className = "b"; copy.textContent = "Copy";
    copy.onclick = async () => { try { await navigator.clipboard.writeText(ta.value); copy.textContent = "Copied ✓"; setTimeout(() => (copy.textContent = "Copy"), 1500); } catch { /* ignore */ } };
    const regen = document.createElement("button"); regen.className = "b"; regen.textContent = "↻ Regenerate";
    regen.title = "Re-draft — applies the steer above if you've typed one";
    regen.onclick = () => { if (lastDraft) void draftFor({ ...lastDraft, steer: steer.value.trim() || undefined }); };
    steer.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); regen.click(); } };
    row.append(copy, regen);
    const foot = document.createElement("div"); foot.className = "foot"; foot.textContent = !manualReview
      ? "On your click, Goobi likes this post, fills X's reply box, and updates its local activity state. It never submits."
      : "Manual review mode: X's official composer opens with the draft. You decide whether to edit and post it.";
    p.append(ta, insert, steer, row, foot);
    requestAnimationFrame(() => { if (panelRoot === root) ta.focus(); });
  }
  root.appendChild(p);
  if (opts.loading || opts.note) requestAnimationFrame(() => { if (panelRoot === root) x.focus(); });
}

function toast(msg: string) {
  const host = document.createElement("div");
  Object.assign(host.style, { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: "2147483647", pointerEvents: "none" } as Partial<CSSStyleDeclaration>);
  const root = host.attachShadow({ mode: "closed" });
  const d = document.createElement("div");
  Object.assign(d.style, { background: "#1d1812", color: "#f3ead9", border: "0.5px solid rgba(214,154,92,.18)", borderRadius: "10px", padding: "10px 14px", font: "12.5px -apple-system, system-ui, sans-serif", maxWidth: "320px", boxShadow: "0 12px 40px rgba(0,0,0,.5)" } as Partial<CSSStyleDeclaration>);
  d.textContent = msg;
  d.setAttribute("role", "status"); d.setAttribute("aria-live", "polite"); // announce transient toasts to screen readers
  root.appendChild(d);
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 6000);
}

/* ---------- opportunities dock (always-on, ranked top posts) ---------- */

const DOCK_CSS = `
/* Warm studio utility: a quiet workbench, with play reserved for Goobi. */
:host {
  --g-bg:#14110d; --g-surface:#1d1812; --g-raised:#221c15; --g-hover:#2c241d;
  --g-text:#f3ead9; --g-muted:#b6a892; --g-subtle:#a89a82;
  --g-accent:#d69a5c; --g-accent-hover:#e7b277; --g-focus:#e89a3c;
  --g-success:#6fcf7f; --g-warning:#e89a3c; --g-danger:#d6604a;
  --g-border:rgba(214,154,92,.24);
}
/* Keyboard a11y: one consistent, always-visible focus ring across every interactive element
   (some inputs set outline:none for aesthetics — :focus-visible restores keyboard visibility). */
:focus-visible { outline:2px solid var(--g-focus); outline-offset:2px; border-radius:4px; }
/* Vestibular a11y: honor the OS-level reduced-motion preference for all CSS motion. */
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
.l { display:flex; align-items:center; gap:9px; background:#1d1812; color:#f3ead9; border:1px solid rgba(214,154,92,.3); border-radius:14px;
     cursor:pointer; text-align:left; font:600 12px -apple-system,system-ui,sans-serif; padding:7px 14px 7px 9px;
     box-shadow:0 8px 28px rgba(0,0,0,.45); }
.l:hover { border-color:rgba(214,154,92,.55); }
.lgoobi { display:inline-flex; flex:0 0 auto; }
.ltext { display:flex; flex-direction:column; line-height:1.25; min-width:0; }
.ll1 { font-weight:600; color:#f3ead9; }
.ll2 { font-size:10.5px; font-weight:500; color:#96876f; margin-top:1px; } /* #96876f: 5.03:1 on the pill bg — the old #8c7d68 was 4.40:1, under AA */
.lavs { display:inline-flex; align-items:center; margin-left:10px; flex:0 0 auto; }
.lav { width:22px; height:22px; border-radius:50%; object-fit:cover; border:1.5px solid #1d1812; box-sizing:border-box; background:#221c15; }
.lav + .lav { margin-left:-9px; }
.lavinit { display:inline-flex; align-items:center; justify-content:center; font:700 9px -apple-system,system-ui,sans-serif; color:#fff; }
.lmore { display:inline-flex; align-items:center; justify-content:center; font:700 9px -apple-system,system-ui,sans-serif; color:#cbb89c; background:#2a2118; }
.lctl { display:inline-flex; align-items:center; gap:4px; margin-left:9px; flex:0 0 auto; }
.lbtn { display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:50%;
        background:#2a2118; color:#cbb89c; border:.5px solid rgba(214,154,92,.25); cursor:pointer; font:600 10px -apple-system,system-ui,sans-serif; padding:0; }
.lbtn:hover { border-color:rgba(214,154,92,.55); color:#f3ead9; }
.lbtn:disabled { opacity:.45; cursor:default; }
.d { width:min(452px, calc(100vw - 24px)); max-width:calc(100vw - 24px); max-height:calc(100vh - 24px); display:flex; flex-direction:column; position:relative;
     background:#14110d; color:#f3ead9; border:1px solid rgba(214,154,92,.18); border-radius:16px;
     font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif; box-shadow:0 16px 48px rgba(0,0,0,.55); }
.d.wide { width:min(680px, calc(100vw - 24px)); max-height:calc(100vh - 24px); } /* the Post-ideas writing surface gets more room */
.d.wide .idea-ta { font-size:15px; }
.d.wide .dl { padding-bottom:18px; }
.dh { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:56px; box-sizing:border-box; padding:9px 14px 7px; flex:0 0 auto; }
.dtitle { font-weight:650; font-size:14px; letter-spacing:-.1px; }
.dsub { font-weight:400; font-size:12px; color:var(--g-subtle); margin-top:3px; }
.pace { font-weight:500; white-space:nowrap; cursor:default; }
.mom { padding:7px 14px; max-height:92px; overflow:auto; box-sizing:border-box; background:rgba(214,154,92,.035); border-bottom:1px solid rgba(214,154,92,.1); flex:0 0 auto; }
.mom-sum { cursor:pointer; -webkit-user-select:none; user-select:none; }
.mom-bar { width:100%; height:5px; border-radius:5px; background:rgba(214,154,92,.12); overflow:hidden; } /* full-width progress bar */
.mom-meta { display:flex; align-items:center; gap:8px; margin-top:5px; } /* state label + facts + caret, below the bar */
.mom-fill { height:100%; border-radius:5px; transition:width .6s ease, background .3s; }
.mom-label { font:600 11px -apple-system,system-ui,sans-serif; white-space:nowrap; }
.mom-bits { display:flex; align-items:center; gap:5px; font-size:10.5px; color:#8c7d68; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:1 1 auto; }
.mom-car { flex:0 0 auto; color:#8c7d68; font-size:10px; }
.mom-coach { font-size:11px; color:#b6a892; margin-top:5px; line-height:1.35; }
.mom-coach.warn { color:#d6604a; font-weight:600; }
.mom-coach.amber { color:#e89a3c; }
.mom-detail { margin-top:4px; padding-top:3px; border-top:.5px dashed rgba(214,154,92,.12); }
.mom-cue { font-size:10.5px; color:#8c7d68; margin-top:6px; line-height:1.35; }
.insight { border-bottom:.5px solid rgba(214,154,92,.1); }
.rel-summary { display:flex; align-items:center; gap:8px; width:100%; min-height:34px; box-sizing:border-box; padding:6px 14px; border:0; border-top:1px solid rgba(214,154,92,.1); border-bottom:1px solid rgba(214,154,92,.1); background:transparent; color:var(--g-subtle); cursor:pointer; text-align:left; flex:0 0 auto; }
.rel-summary:hover { background:rgba(214,154,92,.045); color:var(--g-text); }
.rel-summary-title { flex:0 0 auto; font:600 11px -apple-system,system-ui,sans-serif; color:var(--g-muted); }
.rel-summary-facts { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:500 11px -apple-system,system-ui,sans-serif; }
.rel-summary-caret { flex:0 0 auto; }
.rel-tabs { display:flex; gap:6px; padding:8px 14px; flex:0 0 auto; }
.rel-tab { flex:1; display:flex; align-items:center; justify-content:center; gap:5px; padding:7px 6px; border-radius:9px; border:.5px solid rgba(214,154,92,.2); background:none; color:#cbb89c; font:600 11px -apple-system,system-ui,sans-serif; cursor:pointer; white-space:nowrap; }
.rel-tab:hover { color:#f3ead9; }
.rel-tab.on { background:rgba(214,154,92,.13); border-color:transparent; color:#f3ead9; }
.rel-badge { min-width:15px; text-align:center; font-size:9px; font-weight:700; padding:1px 5px; border-radius:999px; background:rgba(214,154,92,.22); color:#e6d6ba; }
.rel-badge.amber { background:#e89a3c; color:#1a1206; }
.rel-body { border-top:1px solid rgba(214,154,92,.1); flex:0 1 auto; min-height:0; max-height:180px; overflow-y:auto; } /* secondary context must never push the reply queue below the fold */
.ins-body { padding:2px 14px 12px; }
.ins-trend { font-size:11px; color:#6fcf7f; margin:2px 0 8px; font-weight:500; }
.ins-fact { font-size:11px; color:#8c7d68; margin:2px 0 6px; } /* neutral insight line — green means POSITIVE, not "any insight" */
.ins-learn { font-size:11px; color:#8c7d68; line-height:1.4; padding:4px 0; }
.ins-row { display:flex; align-items:center; gap:9px; padding:6px 0; }
.ins-av { width:24px; height:24px; border-radius:50%; flex:0 0 auto; object-fit:cover; background:rgba(214,154,92,.15); }
.ins-av-l { display:flex; align-items:center; justify-content:center; font:600 11px -apple-system,system-ui,sans-serif; color:#8c7d68; }
.ins-mid { flex:1; min-width:0; }
.ins-top { display:flex; align-items:center; gap:6px; }
.ins-h { font:600 12px -apple-system,system-ui,sans-serif; color:#e6d6ba; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:120px; } /* @handle — readable on dark (was #3a3027, dark-on-dark) */
.ins-ar { font-size:11px; color:#8c7d68; }
.ins-badge { font-size:9.5px; color:#6fcf7f; font-weight:600; white-space:nowrap; }
.ins-thin { font-size:9px; color:#a89a85; opacity:.8; }
.ins-meta { font-size:10.5px; color:#a89a85; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } /* reply snippet / row meta — lifted from #8c7d68 for legibility */
.ins-bar { height:4px; border-radius:3px; background:rgba(214,154,92,.12); margin-top:4px; overflow:hidden; }
.ins-fill { height:100%; border-radius:3px; background:#c9b79a; }
.ins-pips { font-size:8px; color:#c9a25a; letter-spacing:1px; flex:0 0 auto; }
.ins-nudge { font-size:10.5px; color:#e89a3c; line-height:1.4; margin-top:8px; padding-top:8px; border-top:.5px solid rgba(214,154,92,.12); }
.ins-more { font-size:10px; color:#8c7d68; margin-top:8px; }
.ins-foot { font-size:9.5px; color:#a89a85; line-height:1.45; margin-top:8px; padding-top:8px; border-top:.5px solid rgba(214,154,92,.12); }
.ins-rel { font-size:9.5px; font-weight:600; white-space:nowrap; }
.ins-rel-mut { color:#6fcf7f; }
.ins-rel-fan { color:#c9a25a; }
.da { display:flex; align-items:center; gap:7px; flex:0 0 auto; }
.discovery { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; padding:0 14px 9px; flex:0 0 auto; }
.discovery .findb { width:100%; min-width:0; }
.fresh-receipt { grid-column:1/-1; min-width:0; padding:6px 8px; border-radius:8px; background:rgba(214,154,92,.07); color:#a99a83; font-size:10px; line-height:1.35; }
.fresh-receipt strong { color:#e0a45c; font-weight:750; }
.scanb { background:none; border:.5px solid rgba(214,154,92,.32); color:${ACCENT}; border-radius:999px;
         font:500 12px -apple-system,system-ui,sans-serif; padding:6px 12px; cursor:pointer; white-space:nowrap; }
.scanb:hover { background:rgba(214,154,92,.10); } .scanb:disabled { opacity:.6; cursor:default; }
.findb { min-height:34px; padding:7px 12px; border:0; border-radius:9px; background:${ACCENT}; color:${INK}; font:700 11.5px -apple-system,system-ui,sans-serif; cursor:pointer; white-space:nowrap; }
.findb:hover { filter:brightness(1.06); } .findb:disabled { opacity:.52; cursor:default; }
.findb.secondary { border:1px solid var(--g-border); background:transparent; color:var(--g-accent-hover); }
.findb.secondary:hover { background:rgba(214,154,92,.10); filter:none; }
.foot .findb { margin-top:10px; }
.iconb { background:none; border:1px solid var(--g-border); color:var(--g-subtle); border-radius:9px;
         width:34px; height:34px; cursor:pointer; font-size:15px; line-height:1; flex:0 0 auto; }
.iconb:hover { background:#221c15; }
.kback { position:absolute; inset:0; z-index:5; }
.kmenu { position:absolute; top:50px; right:14px; z-index:6; background:#221c15; border:.5px solid rgba(214,154,92,.22);
         border-radius:11px; padding:5px; display:flex; flex-direction:column; gap:2px; min-width:152px; box-shadow:0 12px 32px rgba(0,0,0,.5); }
.kitem { background:none; border:0; color:#f3ead9; text-align:left; font:500 12.5px -apple-system,system-ui,sans-serif;
         padding:8px 10px; border-radius:7px; cursor:pointer; }
.kitem:hover { background:#2c241d; } .kitem:disabled { opacity:.5; cursor:default; }
.tabs { display:flex; gap:4px; padding:0 14px 8px; flex:0 0 auto; }
.reply-tools { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 14px; border-bottom:1px solid rgba(214,154,92,.08); }
.reply-tools-label { color:var(--g-muted); font-size:12px; font-weight:600; }
.reply-tools-btn { min-height:32px; padding:5px 10px; border:1px solid var(--g-border); border-radius:8px; background:transparent; color:var(--g-subtle); font:600 11px -apple-system,system-ui,sans-serif; cursor:pointer; }
.reply-tools-btn:hover { background:var(--g-raised); color:var(--g-text); }
.tab { flex:1; min-height:32px; border:1px solid transparent; border-radius:9px; background:none; color:var(--g-subtle);
       font:600 12px -apple-system,system-ui,sans-serif; padding:7px 4px; cursor:pointer; white-space:nowrap; }
.tab:hover { color:#cbb89c; } .tab.on { background:rgba(214,154,92,.13); border-color:rgba(214,154,92,.32); color:#e7b277; }
.modes { display:flex; gap:6px; min-height:42px; box-sizing:border-box; padding:4px 14px 6px; border-top:1px solid rgba(214,154,92,.08); border-bottom:1px solid rgba(214,154,92,.08); flex:0 0 auto; }
.mode { flex:1; min-height:36px; border:1px solid var(--g-border); border-radius:10px; background:none; color:var(--g-subtle); font:600 12px -apple-system,system-ui,sans-serif; padding:8px 4px; cursor:pointer; }
.mode:hover { color:#cbb89c; }
.mode.on { background:${ACCENT}; border-color:transparent; color:${INK}; }
.mode-count { display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px; margin-left:5px; padding:0 4px; box-sizing:border-box; border-radius:999px; background:rgba(20,17,13,.2); font-size:10px; line-height:1; }
.day-goals { flex:0 0 auto; padding:10px 14px 11px; border-bottom:1px solid rgba(214,154,92,.08); background:linear-gradient(180deg,rgba(30,24,18,.62),rgba(20,17,13,.38)); }
.dg-head { display:flex; align-items:center; gap:7px; margin-bottom:8px; }
.dg-title { color:var(--g-muted); font-size:10px; font-weight:800; letter-spacing:.65px; text-transform:uppercase; }
.dg-summary { color:var(--g-subtle); font-size:10px; }
.dg-edit { margin-left:auto; border:0; background:none; color:var(--g-subtle); font:600 10px -apple-system,system-ui,sans-serif; cursor:pointer; padding:2px 3px; }
.dg-edit:hover { color:var(--g-text); }
.dg-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
.dg-item { min-width:0; padding:8px 9px; border:1px solid rgba(214,154,92,.13); border-radius:10px; background:#17130f; color:inherit; cursor:pointer; text-align:left; }
.dg-item:hover { border-color:rgba(214,154,92,.3); background:#1d1812; }
.dg-item.done { border-color:rgba(111,207,127,.22); background:rgba(111,207,127,.055); }
.dg-item.primary { grid-column:1/-1; padding:11px 12px 10px; border-color:rgba(214,154,92,.32); background:linear-gradient(135deg,rgba(214,154,92,.12),#17130f 62%); }
.dg-top { display:flex; align-items:baseline; justify-content:space-between; gap:5px; }
.dg-label { min-width:0; color:var(--g-muted); font-size:10.5px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dg-count { color:var(--g-text); font-size:11px; font-weight:750; white-space:nowrap; }
.dg-item.primary .dg-label { color:#e7b277; font-size:12px; font-weight:780; }
.dg-item.primary .dg-count { font-size:14px; }
.dg-helper { display:block; margin-top:3px; color:var(--g-subtle); font-size:10.5px; line-height:1.3; }
.dg-item.done .dg-count { color:#7fcf8d; }
.dg-track { display:block; height:4px; margin-top:7px; border-radius:999px; overflow:hidden; background:#30271e; }
.dg-item.primary .dg-track { height:7px; margin-top:9px; background:#382c21; }
.dg-fill { display:block; height:100%; border-radius:999px; background:${ACCENT}; }
.dg-item.done .dg-fill { background:#6fcf7f; }
.growth { flex:1 1 auto; min-height:0; overflow:auto; padding:12px 14px 18px; display:flex; flex-direction:column; gap:10px; }
.gx-hero,.gx-card { border:1px solid var(--g-border); border-radius:13px; background:var(--g-surface); padding:13px; }
.gx-hero { background:linear-gradient(145deg,rgba(214,154,92,.13),rgba(34,28,21,.76)); border-color:rgba(214,154,92,.3); }
.gx-kicker { color:${ACCENT}; font-size:10px; font-weight:750; letter-spacing:.08em; text-transform:uppercase; }
.gx-title { color:var(--g-text); font-size:16px; font-weight:720; line-height:1.25; margin-top:3px; }
.gx-copy { color:var(--g-muted); font-size:12px; line-height:1.45; margin-top:5px; }
.gx-metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; margin-top:11px; }
.gx-metric { border:1px solid rgba(214,154,92,.14); border-radius:9px; background:rgba(20,17,13,.45); padding:8px; min-width:0; }
.gx-metric b { display:block; color:var(--g-text); font-size:17px; font-weight:680; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gx-metric span { display:block; color:var(--g-subtle); font-size:10px; margin-top:1px; }
.gx-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
.gx-head h3 { margin:0; color:var(--g-text); font-size:13.5px; }
.gx-day { flex:none; color:var(--g-subtle); font-size:10.5px; }
.gx-hyp { color:#cbb89c; font-size:12px; line-height:1.45; margin-top:6px; }
.gx-play { display:grid; gap:6px; margin-top:10px; }
.gx-play div { color:var(--g-muted); font-size:11.5px; line-height:1.4; padding-left:14px; position:relative; }
.gx-play div:before { content:'◆'; position:absolute; left:0; color:${ACCENT}; font-size:8px; top:3px; }
.gx-read { margin-top:10px; border-top:1px solid rgba(214,154,92,.12); padding-top:9px; }
.gx-read b { color:var(--g-text); font-size:12px; }
.gx-read div { color:var(--g-muted); font-size:11px; margin-top:3px; }
.gx-actions { display:flex; gap:7px; align-items:center; margin-top:11px; }
.gx-select { flex:1; min-width:0; background:#1a1510; color:var(--g-text); border:1px solid var(--g-border); border-radius:9px; padding:8px 9px; font:600 11.5px -apple-system,system-ui,sans-serif; }
.gx-btn { border:0; border-radius:9px; background:${ACCENT}; color:${INK}; font:700 11.5px -apple-system,system-ui,sans-serif; padding:9px 12px; cursor:pointer; white-space:nowrap; }
.gx-btn.secondary { border:1px solid var(--g-border); background:none; color:var(--g-muted); }
.gx-btn:disabled { opacity:.46; cursor:default; }
.gx-find { color:var(--g-muted); font-size:11.5px; line-height:1.45; margin-top:7px; }
.gx-find.good { color:#7fcf8d; } .gx-find.act { color:#dca26a; }
.gx-history { display:flex; flex-direction:column; gap:6px; margin-top:8px; }
.gx-hrow { color:var(--g-muted); font-size:11px; padding-top:7px; border-top:1px solid rgba(214,154,92,.09); }
.gx-hmain { display:flex; justify-content:space-between; gap:8px; }
.gx-hmeta { color:var(--g-subtle); font-size:10px; line-height:1.35; margin-top:3px; }
.gx-hrow b { color:#cbb89c; font-weight:600; }
.comments { flex:1 1 auto; min-height:0; overflow:hidden; display:flex; flex-direction:column; }
.comments-intro { margin:12px 14px 8px; padding:12px 13px; border:1px solid rgba(111,207,127,.22); border-radius:12px; background:linear-gradient(145deg,rgba(111,207,127,.08),rgba(34,28,21,.55)); flex:0 0 auto; }
.comments-title { color:var(--g-text); font-size:14px; font-weight:700; }
.comments-copy { color:var(--g-muted); font-size:11.5px; line-height:1.45; margin-top:4px; }
.comments .rel-body { flex:1 1 auto; max-height:none; border-top:0; border-bottom:0; overflow-y:auto; }
.comments .ins-body { padding-top:2px; }
.comments-empty { margin:6px 14px 14px; padding:18px 14px; border:1px dashed var(--g-border); border-radius:11px; color:var(--g-muted); font-size:12px; line-height:1.5; text-align:center; }
.comments-empty .gx-btn { margin-top:11px; }
.ideas { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
.idea-compose { margin:2px 14px 12px; padding:14px; border:1px solid rgba(214,154,92,.3); border-radius:13px; background:linear-gradient(145deg,rgba(214,154,92,.11),rgba(34,28,21,.72)); flex:0 0 auto; }
.idea-compose-top { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.idea-compose-title { color:var(--g-text); font-size:15px; font-weight:700; letter-spacing:-.1px; }
.idea-compose-sub { color:var(--g-muted); font-size:11.5px; margin-top:2px; }
.idea-rough { width:100%; min-height:74px; box-sizing:border-box; margin-top:11px; padding:10px 11px; resize:vertical; border:1px solid var(--g-border); border-radius:10px; background:var(--g-bg); color:var(--g-text); font:13px/1.5 -apple-system,system-ui,sans-serif; }
.idea-rough::placeholder { color:var(--g-subtle); }
.idea-rough:focus { border-color:var(--g-focus); outline:none; box-shadow:0 0 0 2px rgba(232,154,60,.16); }
.idea-compose-actions { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:8px; }
.idea-rough-count { color:var(--g-subtle); font-size:11px; }
.idea-polish { min-height:36px; padding:8px 13px; border:0; border-radius:9px; background:var(--g-accent); color:#1a1206; font:700 12px -apple-system,system-ui,sans-serif; cursor:pointer; }
.idea-polish:hover { background:var(--g-accent-hover); }
.idea-polish:disabled { opacity:.5; cursor:default; }
.idea-compose-error { margin-top:8px; color:#e8a08c; font-size:11.5px; line-height:1.4; }
.idea-compose-status { margin-top:8px; color:var(--g-accent-hover); font-size:11.5px; line-height:1.4; }
.idea-seeds { padding:0 14px 10px; max-height:260px; overflow:auto; flex:0 1 auto; }
.idea-seeds > .idea-section-title { margin:0 0 7px; }
.ideahead { padding:0 14px 9px; flex:0 0 auto; }
.idea-section-title { color:var(--g-text); font-size:13px; font-weight:700; }
.idea-head-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.idea-clear { min-height:32px; padding:5px 9px; border:1px solid var(--g-border); border-radius:8px; background:transparent; color:var(--g-subtle); font:600 11px -apple-system,system-ui,sans-serif; cursor:pointer; }
.idea-clear:hover { color:var(--g-text); background:var(--g-raised); }
.idea-clear.armed { border-color:var(--g-danger); background:rgba(214,96,74,.1); color:#e8a08c; }
.idea-clear:not(:disabled):where(:focus-visible) { border-color:var(--g-danger); }
.idea-clear:disabled { opacity:.4; cursor:default; }
.idea-niche-note { margin-top:8px; padding:8px 10px; border-radius:9px; background:rgba(214,154,92,.07); color:var(--g-muted); font-size:11px; line-height:1.4; }
.ideasub { font-size:10.5px; color:#8c7d68; margin-top:6px; line-height:1.4; }
.idea { position:relative; display:flex; align-items:stretch; background:#1b150f; border:1px solid rgba(214,154,92,.16); border-radius:12px; padding:0; margin-bottom:9px; cursor:pointer; overflow:hidden; transition:background .12s, border-color .12s; }
.idea:hover { background:#201a12; border-color:rgba(214,154,92,.28); }
.idea.open { cursor:default; background:#1d1710; border-color:rgba(214,154,92,.34); flex-wrap:wrap; }
.idea.open .idea-main { display:none; }
.idea.open .idea-rowact { margin-left:auto; padding:8px 11px 4px; }
.idea.dimmed { opacity:.5; pointer-events:none; }
.idea-pip { flex:0 0 4px; align-self:stretch; background:rgba(214,154,92,.18); }
.idea.kept { border-color:rgba(214,154,92,.42); }
.idea.remind-due { border-color:rgba(232,154,60,.5); box-shadow:0 0 0 1px rgba(232,154,60,.22); }
.idea-remind-chip { color:var(--g-warning); font-weight:700; }
.idea-remind-chip.overdue { color:var(--g-danger); }
.idea-remind { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:2px; }
.idea-remind-note { flex-basis:100%; font-size:10px; color:#8c7d68; line-height:1.4; }
.idea-remind-dt { background:#221c15; border:1px solid rgba(214,154,92,.25); color:#cbb89c; border-radius:8px; font:600 11px -apple-system,system-ui,sans-serif; padding:4px 6px; color-scheme:dark; }
.idea-main { flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:7px; padding:13px 8px 13px 13px; }
.idea-hook { font:600 13px -apple-system,system-ui,sans-serif; color:#f3ead9; line-height:1.45; white-space:pre-wrap; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.idea.open .idea-hook { display:none; }
.idea-meta { font-size:11px; color:var(--g-subtle); line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.idea-meta b { font-weight:700; }
.idea-summary { font-size:11px; color:#8c7d68; margin-top:6px; } .idea-summary b { font-weight:700; }
.idea-improve { border:.5px solid rgba(232,154,60,.4); background:rgba(232,154,60,.14); color:#e89a3c; border-radius:9px; padding:8px 12px; font:600 12px inherit; cursor:pointer; }
.idea-improve:hover { background:rgba(232,154,60,.22); } .idea-improve:disabled { opacity:.6; cursor:default; }
.idea.open .idea-meta { display:none; }
.idea-rowact { flex:0 0 auto; display:flex; align-items:center; padding:0 11px 0 3px; }
.idea-edit { min-width:48px; min-height:32px; border:1px solid var(--g-border); border-radius:8px; background:transparent; color:var(--g-accent-hover); font:600 11px -apple-system,system-ui,sans-serif; cursor:pointer; }
.idea-edit:hover { background:var(--g-raised); color:var(--g-text); }
.idea-quickopen { border:0; background:none; color:${ACCENT}; font-size:15px; line-height:1; width:30px; height:30px; border-radius:8px; cursor:pointer; }
.idea-quickopen:hover { background:rgba(214,154,92,.14); }
.idea.open .idea-quickopen { display:none; }
.idea-chev { color:#8c7d68; font-size:11px; width:14px; text-align:center; transition:transform .15s; }
.idea.open .idea-chev { transform:rotate(90deg); }
.idea-body { flex-basis:100%; order:99; display:none; padding:3px 14px 14px; }
.idea.open .idea-body { display:block; }
.idea-draft-label { display:block; margin-bottom:6px; color:var(--g-muted); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.45px; }
.idea-ta { width:100%; box-sizing:border-box; margin:0 0 2px; background:var(--g-bg); color:#f3ead9; border:1px solid var(--g-border); border-radius:10px; padding:10px 11px; font:inherit; font-size:14px; line-height:1.55; resize:none; white-space:pre-wrap; min-height:72px; }
.idea-ta:focus { outline:none; border-color:var(--g-focus); box-shadow:0 0 0 2px rgba(232,154,60,.13); }
.idea-quality { margin-top:8px; color:var(--g-muted); font-size:11.5px; line-height:1.4; }
.idea-why-toggle { display:block; width:100%; margin-top:11px; padding:7px 0; border:0; border-top:1px solid rgba(214,154,92,.12); background:transparent; color:var(--g-subtle); text-align:left; font:600 11px -apple-system,system-ui,sans-serif; cursor:pointer; }
.idea-why-toggle:hover { color:var(--g-text); }
.idea-details { padding:1px 0 4px; }
.idea-detail-meta { margin-top:7px; color:var(--g-subtle); font-size:11px; line-height:1.4; }
.idea-outcome { margin-top:9px; padding:9px 10px; border:1px solid rgba(111,207,127,.2); border-radius:9px; background:rgba(111,207,127,.06); color:#b8c7ad; font-size:11px; line-height:1.45; }
.idea-outcome a { color:#8bd397; text-decoration:none; font-weight:650; }
.idea-outcome a:hover { text-decoration:underline; }
.idea-why { font-size:12px; color:#b6a892; margin-top:10px; line-height:1.5; }
.idea-src { font-size:11px; color:var(--g-subtle); margin-top:9px; }
.idea-srctog { display:block; width:100%; padding:4px 0; border:0; background:none; text-align:left; font:inherit; color:inherit; cursor:pointer; }
.idea-srctog:hover { color:#cbb89c; }
.idea-quote { margin-top:7px; border-left:2px solid rgba(214,154,92,.3); padding:2px 0 2px 9px; }
.idea-qtext { font-size:11.5px; color:#b6a892; line-height:1.4; display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-wrap; }
.idea-qfoot { display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:10.5px; color:#8c7d68; }
.idea-qlink { color:${ACCENT}; text-decoration:none; }
.idea-actions { display:flex; gap:7px; align-items:center; flex-wrap:wrap; margin-top:12px; padding-top:11px; border-top:1px solid rgba(214,154,92,.12); }
.idea-quiet-actions { display:flex; align-items:center; gap:2px; margin-left:auto; }
.idea-open { border:0; border-radius:9px; padding:8px 14px; font:600 12px inherit; cursor:pointer; background:${ACCENT}; color:${INK}; }
.idea-open:hover { filter:brightness(1.06); }
.idea-copy { border:.5px solid rgba(214,154,92,.28); background:none; color:#cbb89c; border-radius:9px; padding:8px 12px; font:600 12px inherit; cursor:pointer; }
.idea-copy:hover { background:rgba(214,154,92,.1); color:#f3ead9; }
.idea-pin { border:0; background:none; color:var(--g-subtle); border-radius:8px; padding:6px 8px; cursor:pointer; font-size:11px; }
.idea-pin + .idea-pin { margin-left:0; }
.idea-pin.on { background:rgba(214,154,92,.14); border-color:transparent; color:${ACCENT}; }
.idea-pin:hover { background:var(--g-raised); color:var(--g-text); }
.idea-delete:hover { color:#e8a08c; }
.idea-trend { font-size:10.5px; color:#8c7d68; margin-top:6px; }
.idea-trend b { color:#cbb89c; }
.idea-streak { font:600 11.5px -apple-system,system-ui,sans-serif; color:#cbb89c; margin:0; }
.idea-streak b { color:${ACCENT}; }
.ideagate-t { font-weight:600; font-size:13.5px; color:#cbb89c; }
.idea.busy .idea-ta { opacity:.5; }
.idea.shipped { opacity:.85; }
.idea.shipped .idea-hook { color:#b6a892; }
.idea-steer { display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-top:10px; }
.idea-chip { border:1px solid rgba(214,154,92,.25); background:#221c15; color:#cbb89c; border-radius:8px; font:600 11px -apple-system,system-ui,sans-serif; padding:5px 9px; cursor:pointer; }
.idea-chip:hover { background:rgba(214,154,92,.13); color:#f3ead9; }
.idea-undo { color:#8c7d68; }
.idea-steerin { flex:1; min-width:90px; background:#1a1510; color:#f3ead9; border:1px solid rgba(214,154,92,.2); border-radius:8px; padding:6px 9px; font:inherit; font-size:11px; }
.idea-steerin:focus { outline:none; border-color:${ACCENT}; }
.idea-steerbusy { font-size:11px; color:#cbb89c; padding:4px 0; }
.idea-shiptog { font-size:11px; color:#8c7d68; cursor:pointer; padding:6px 2px 10px; }
.idea-shiptog:hover { color:#cbb89c; }
.idea-load { display:flex; align-items:center; justify-content:center; height:96px; }
.idea-loadcap { text-align:center; font-size:11.5px; color:#a89a85; line-height:1.4; padding:2px 18px 10px; }
.ideahead-top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.idea-gate { text-align:center; padding:24px 16px; margin:2px 0; border:.5px dashed rgba(214,154,92,.24); border-radius:12px; background:#1b150f; }
.idea-err { text-align:center; padding:20px 18px; margin:4px 0; border-radius:12px; background:rgba(214,96,74,.08); border:.5px solid rgba(214,96,74,.28); }
.idea-err-t { color:#e8a08c; font:600 12.5px -apple-system,system-ui,sans-serif; margin-bottom:10px; }
.idea-err .scanb { display:inline-flex; margin:0 auto; }
.idea-empty { text-align:center; padding:26px 18px; color:#8c7d68; font-size:12.5px; line-height:1.5; }
.idea-list { padding:0 14px 10px; }
.idea-list .idea-err { text-align:left; padding:11px 12px; margin:0 0 9px; }
.idea-list .idea-err-t { margin:0 0 8px; line-height:1.4; }
.idea-list .idea-empty { margin:0; padding:28px 16px; border:1px dashed rgba(214,154,92,.2); border-radius:12px; color:var(--g-muted); background:rgba(214,154,92,.035); }
.tg-add { display:flex; gap:6px; margin-top:9px; }
.tg-add .idea-steerin { flex:1; }
.tg-card { background:#1b150f; border:.5px solid rgba(214,154,92,.16); border-radius:12px; padding:11px 12px; margin-bottom:7px; }
.tg-top { display:flex; align-items:center; gap:9px; }
.tg-x { margin-left:auto; background:none; border:0; color:#8c7d68; font-size:17px; line-height:1; cursor:pointer; padding:2px 4px; flex:0 0 auto; }
.tg-x:hover { color:#e0a45c; }
.tg-stand { font-size:11px; margin-top:8px; line-height:1.4; }
.tg-good { color:#6fcf7f; }
.tg-muted { color:#8c7d68; }
.tg-find { margin-top:10px; background:none; border:.5px solid rgba(214,154,92,.3); color:#e7b277; border-radius:9px; padding:7px 12px; font:600 12px inherit; cursor:pointer; }
.tg-find:hover { background:rgba(214,154,92,.1); } .tg-find:disabled { opacity:.55; cursor:default; }
.tg-post { margin-top:10px; font-size:13px; color:#cbb89c; line-height:1.45; background:#221c15; border-radius:9px; padding:9px 10px; white-space:pre-wrap; max-height:120px; overflow:auto; }
.tg-fresh { font-size:10.5px; color:#8c7d68; margin-top:6px; }
.tg-live { color:#6fcf7f; font-weight:600; }
.tg-warn { font-size:10.5px; color:#e89a3c; margin-top:7px; line-height:1.4; }
.tg-foot { font-size:9.5px; color:#a89a85; margin-top:8px; line-height:1.4; }
.tg-sughead { font:600 11.5px -apple-system,system-ui,sans-serif; color:#cbb89c; margin:2px 0; }
.tg-sug { display:flex; align-items:center; gap:9px; padding:7px 0; border-bottom:.5px solid rgba(214,154,92,.08); }
.tg-radar-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 10px; margin:2px 0 3px; border:1px solid rgba(214,154,92,.24); border-radius:11px; background:linear-gradient(135deg,rgba(214,154,92,.1),rgba(27,21,15,.72)); }
.tg-radar-head > div { min-width:0; }
.tg-radar-head .tg-foot { margin-top:2px; }
.tg-radar-row { padding-left:4px; padding-right:4px; }
.tg-track { padding:5px 10px; font-size:11px; flex:0 0 auto; }
.tg-hh { margin-top:8px; }
.dm-from-target { margin-left:7px; color:#bda98d; }
.dm-head { padding-bottom:12px; }
.dm-stats { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top:10px; }
.dm-stat,.dm-pace,.dm-warm { display:inline-flex; align-items:center; min-height:24px; box-sizing:border-box; padding:3px 8px; border-radius:999px; border:1px solid rgba(214,154,92,.18); background:#221c15; color:#b6a892; font:650 10.5px -apple-system,system-ui,sans-serif; }
.dm-stat.hot { border-color:rgba(232,154,60,.42); color:#e7b277; background:rgba(232,154,60,.1); }
.dm-pace { margin-left:auto; color:#8c7d68; }
.dm-pace.caution { color:#e89a3c; } .dm-pace.pause { color:#e88c77; }
.dm-next { display:flex; align-items:center; gap:10px; margin-top:10px; padding:10px 11px; border:1px solid rgba(111,207,127,.24); border-radius:11px; background:linear-gradient(135deg,rgba(111,207,127,.09),rgba(34,28,21,.72)); }
.dm-next-mark { flex:0 0 auto; color:#79d68a; font:750 9px -apple-system,system-ui,sans-serif; letter-spacing:.65px; }
.dm-next-copy { flex:1; min-width:0; }
.dm-next-label { color:#f3ead9; font-size:12px; font-weight:700; }
.dm-next-why { margin-top:2px; color:#b6a892; font-size:10.5px; line-height:1.35; }
.dm-next-act { flex:0 0 auto; padding:7px 11px; }
.dm-outcomes { margin-top:8px; color:#a89a82; font-size:10.5px; line-height:1.4; }
.dm-outcomes b { color:#cbb89c; }
.dm-learning { display:block; margin-top:2px; color:#8c7d68; }
.dm-people-learning { color:#a89a82; }
.dm-add { display:grid; grid-template-columns:minmax(90px,.55fr) minmax(180px,1.45fr) auto; gap:7px; margin-top:10px; }
.dm-add .idea-steerin { min-height:34px; box-sizing:border-box; }
.dm-message { margin-top:7px; color:#e7b277; font-size:11px; }
.dm-list { padding:0 14px 14px; }
.dm-suggestions { margin:2px 0 12px; padding:11px 12px; border:1px solid rgba(214,154,92,.15); border-radius:12px; background:rgba(214,154,92,.035); }
.dm-section-title { color:#f3ead9; font-size:12.5px; font-weight:700; }
.dm-section-sub { color:#8c7d68; font-size:10.5px; margin:2px 0 6px; }
.dm-suggestion { display:flex; align-items:center; gap:9px; min-height:42px; border-top:1px solid rgba(214,154,92,.08); }
.dm-suggestion-main { flex:1; min-width:0; }
.dm-warm { min-height:21px; padding:2px 7px; }
.dm-warm.warm { color:#6fcf7f; border-color:rgba(111,207,127,.25); background:rgba(111,207,127,.07); }
.dm-warm.research { color:#a89a82; }
.dm-plan { padding:5px 9px; flex:0 0 auto; }
.dm-empty { border:1px dashed rgba(214,154,92,.2); border-radius:12px; background:rgba(214,154,92,.025); }
.dm-card { margin:0 0 8px; padding:11px 12px; border:1px solid rgba(214,154,92,.16); border-radius:13px; background:#1b150f; }
.dm-card.due { border-color:rgba(232,154,60,.38); box-shadow:inset 3px 0 0 rgba(232,154,60,.72); }
.dm-card-top { display:flex; align-items:center; gap:9px; }
.dm-ident { flex:1; min-width:0; }
.dm-stage { flex:0 0 auto; border-radius:999px; padding:3px 8px; background:#221c15; color:#a89a82; font-size:10.5px; font-weight:700; }
.dm-stage.ready,.dm-stage.active { background:rgba(111,207,127,.08); color:#79d68a; }
.dm-stage.waiting { background:rgba(232,154,60,.08); color:#e7b277; }
.dm-stage.won { background:rgba(111,207,127,.14); color:#8bd397; }
.dm-stage.closed { opacity:.7; }
.dm-toggle { width:30px; height:30px; border:0; border-radius:8px; background:transparent; color:#8c7d68; cursor:pointer; }
.dm-toggle:hover { background:#221c15; color:#f3ead9; }
.dm-evidence { margin-top:8px; color:#b6a892; font-size:11.5px; line-height:1.42; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; white-space:pre-wrap; }
.dm-card.open .dm-evidence { -webkit-line-clamp:4; }
.dm-candidate-signal { margin-top:7px; padding:6px 8px; border-radius:8px; background:rgba(111,207,127,.06); color:#8bd397; font-size:10.5px; line-height:1.35; }
.dm-controls { display:flex; gap:7px; margin-top:11px; }
.dm-select { flex:0 1 150px; min-width:0; height:34px; box-sizing:border-box; border:1px solid rgba(214,154,92,.22); border-radius:9px; padding:0 9px; background:#221c15; color:#f3ead9; font:600 11.5px -apple-system,system-ui,sans-serif; }
.dm-product { flex:1 1 220px; }
.dm-goal { width:100%; box-sizing:border-box; margin-top:8px; padding:9px 10px; resize:vertical; border:1px solid rgba(214,154,92,.2); border-radius:9px; background:#14110d; color:#f3ead9; font:12px/1.45 -apple-system,system-ui,sans-serif; }
.dm-goal:focus,.dm-select:focus { outline:none; border-color:#e89a3c; box-shadow:0 0 0 2px rgba(232,154,60,.12); }
.dm-context,.dm-timeline { margin-top:10px; padding:9px 10px; border-radius:10px; background:#221c15; }
.dm-mini-title { margin-bottom:5px; color:#cbb89c; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.35px; }
.dm-context-row { display:flex; align-items:flex-start; gap:8px; padding:5px 0; border-top:1px solid rgba(214,154,92,.08); }
.dm-context-copy { flex:1; min-width:0; color:#b6a892; font-size:11px; line-height:1.4; white-space:pre-wrap; }
.dm-remove { flex:0 0 auto; border:0; background:none; color:#8c7d68; cursor:pointer; font-size:16px; }
.dm-remove:hover { color:#e8a08c; }
.dm-draft { margin-top:10px; resize:vertical; }
.dm-warning { margin-top:7px; color:#e89a3c; font-size:11px; line-height:1.4; }
.dm-actions { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin-top:9px; }
.dm-actions.compact { margin-top:6px; }
.dm-secondary { display:flex; align-items:center; flex-wrap:wrap; gap:2px; margin-top:8px; padding-top:7px; border-top:1px solid rgba(214,154,92,.09); }
.dm-secondary .idea-pin:last-child { margin-left:auto; }
.dm-capture { margin-top:9px; }
.dm-touch { display:flex; align-items:flex-start; gap:8px; padding:4px 0; color:#b6a892; font-size:11px; line-height:1.4; border-top:1px solid rgba(214,154,92,.07); white-space:pre-wrap; }
.dm-touch > span { flex:1; min-width:0; }
.dm-touch.inbound { color:#c9b99f; }
.dm-disclosure,.dm-footer { color:#8c7d68; font-size:10.5px; line-height:1.45; }
.dm-disclosure { margin-top:9px; }
.dm-footer { padding:12px 4px 2px; text-align:center; }
.df { margin:0 14px 8px; background:#221c15; border:.5px solid rgba(214,154,92,.18); border-radius:10px;
      color:#f3ead9; font:inherit; font-size:12.5px; padding:9px 12px; outline:none; flex:0 0 auto; }
.dl { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; padding:0; } /* basis auto: shows its content, grows into leftover, and shrinks+scrolls (with an open .rel-body) when the dock is full */
.it { display:flex; flex-direction:column; padding:6px 10px; border-top:.5px solid rgba(214,154,92,.07); }
.reply-card { border:1px solid transparent; border-radius:13px; background:transparent; transition:background .14s ease,border-color .14s ease,box-shadow .14s ease; }
.reply-card:hover { background:rgba(214,154,92,.035); }
.reply-card.open { background:#1b1712; border-color:rgba(214,154,92,.18); box-shadow:0 8px 24px rgba(0,0,0,.18); }
.reply-card.fresh-hero { margin-bottom:7px; border-color:rgba(214,154,92,.36); background:linear-gradient(145deg,rgba(214,154,92,.12),rgba(27,23,18,.82) 62%); box-shadow:0 10px 28px rgba(0,0,0,.22); }
.reply-card.inbound-own-post { margin-bottom:5px; border-color:rgba(111,207,127,.34); background:linear-gradient(145deg,rgba(111,207,127,.085),rgba(27,23,18,.72) 68%); box-shadow:inset 3px 0 0 rgba(111,207,127,.72); }
.reply-inbound-banner { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:7px 10px 0; padding:7px 9px; border:1px solid rgba(111,207,127,.25); border-radius:9px; background:rgba(111,207,127,.09); }
.reply-inbound-kicker { color:#9be5aa; font-size:10.5px; font-weight:850; letter-spacing:.35px; text-transform:uppercase; }
.reply-inbound-explain { color:#b9cfb9; font-size:10px; line-height:1.3; text-align:right; }
.fresh-hero-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 10px 0; }
.fresh-hero-title { color:#f0b56f; font-size:11.5px; font-weight:800; letter-spacing:.01em; }
.fresh-hero-sub { margin-top:2px; color:#b6a892; font-size:10px; line-height:1.35; }
.fresh-hero-band { flex:0 0 auto; padding:4px 7px; border-radius:999px; background:rgba(214,154,92,.18); color:#efbd80; font-size:9.5px; font-weight:750; text-transform:capitalize; white-space:nowrap; }
.reply-summary { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px; padding:9px 10px; }
.reply-toggle { min-width:0; display:flex; align-items:center; gap:10px; border-radius:9px; cursor:pointer; }
.reply-toggle:focus-visible,.reply-disclose:focus-visible,.reply-draft-quick:focus-visible { outline:2px solid ${ACCENT}; outline-offset:2px; }
.reply-copy { min-width:0; flex:1; }
.reply-id { display:flex; align-items:center; min-width:0; gap:5px; }
.reply-id .nm { min-width:0; }
.reply-compact-meta { display:flex; align-items:center; min-width:0; gap:6px; margin-top:4px; color:#8c7d68; font-size:10.5px; white-space:nowrap; }
.reply-lane { min-width:0; max-width:180px; overflow:hidden; text-overflow:ellipsis; color:#f3ead9; font-weight:700; }
.reply-strength { flex:0 0 auto; padding:1px 6px; border-radius:999px; font-size:9.5px; font-weight:750; text-transform:uppercase; letter-spacing:.28px; }
.reply-repeat { flex:0 0 auto; padding:1px 6px; border-radius:999px; color:#f0b66f; background:rgba(232,154,60,.13); font-size:9.5px; font-weight:700; }
.reply-age { flex:0 0 auto; }
.reply-compact-text { min-width:0; margin-top:4px; color:#b6a892; font-size:11.5px; line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.reply-summary-actions { display:flex; align-items:center; gap:5px; }
.reply-draft-quick { min-height:34px; padding:0 11px; border:0; border-radius:9px; background:${ACCENT}; color:${INK}; cursor:pointer; font:700 11.5px -apple-system,system-ui,sans-serif; white-space:nowrap; }
.reply-draft-quick:hover { filter:brightness(1.06); }
.reply-disclose { display:inline-flex; align-items:center; justify-content:center; width:30px; height:34px; border:0; border-radius:8px; background:transparent; color:#8c7d68; cursor:pointer; font-size:13px; }
.reply-disclose:hover { background:#282018; color:#f3ead9; }
.reply-detail { margin:0 10px 9px 56px; padding-top:10px; border-top:1px solid rgba(214,154,92,.10); }
.reply-post { color:#d8c9b2; font-size:12px; line-height:1.45; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.reply-repeat-warning { margin-top:9px; padding:8px 10px; border-radius:9px; color:#f0b66f; background:rgba(232,154,60,.11); border:1px solid rgba(232,154,60,.28); font-size:11.5px; line-height:1.4; }
.reply-why-card { margin-top:9px; padding:9px 10px; border-radius:10px; background:#221c15; border:1px solid rgba(214,154,92,.11); }
.reply-section-label { color:${ACCENT}; font-size:9.5px; font-weight:800; letter-spacing:.7px; text-transform:uppercase; }
.reply-why-line { display:flex; align-items:flex-start; gap:7px; margin-top:5px; color:#d8c9b2; font-size:11.5px; line-height:1.4; }
.reply-why-dot { flex:0 0 auto; color:${ACCENT}; }
.reply-signal-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; margin-top:9px; }
.reply-signal { padding:7px 8px; border-radius:9px; background:#17130f; border:1px solid rgba(214,154,92,.10); }
.reply-signal-top { display:flex; justify-content:space-between; gap:4px; color:#8c7d68; font-size:9.5px; }
.reply-signal-top b { color:#d8c9b2; font-size:10.5px; }
.reply-signal-track { height:3px; margin-top:6px; overflow:hidden; border-radius:999px; background:#30271e; }
.reply-signal-fill { display:block; height:100%; border-radius:999px; }
.reply-evidence { margin-top:7px; color:#8c7d68; font-size:10.5px; line-height:1.4; }
.reply-detail-actions { display:flex; align-items:center; flex-wrap:wrap; gap:4px; margin-top:9px; padding-top:8px; border-top:1px solid rgba(214,154,92,.08); }
.reply-action { min-height:30px; padding:5px 8px; border:0; border-radius:7px; background:transparent; color:#a99a83; cursor:pointer; font:600 11px -apple-system,system-ui,sans-serif; white-space:nowrap; }
.reply-action:hover { background:#282018; color:#f3ead9; }
.reply-action.remove { margin-left:auto; color:#9a806e; }
.top { display:flex; gap:12px; }
.botacts { display:flex; align-items:center; gap:3px; flex-wrap:wrap; margin-top:8px; padding-top:7px; border-top:.5px solid rgba(214,154,92,.08); }
.av { width:40px; height:40px; border-radius:50%; object-fit:cover; flex:0 0 auto; background:#221c15; }
.av.init { display:inline-flex; align-items:center; justify-content:center; font-size:16px; font-weight:600; color:#fff; }
.bodywrap { flex:1; min-width:0; display:flex; gap:12px; }
.main { flex:1; min-width:0; }
.nm { display:flex; align-items:center; gap:6px; font-weight:600; font-size:14px; }
.nmt { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:0 1 auto; }
.vf { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px;
      border-radius:50%; background:#1d9bf0; color:#fff; font-size:9px; }
.fc { flex:0 0 auto; color:#b6a892; font-weight:500; font-size:12px; white-space:nowrap; }
.ix { color:#b6a892; font-size:13px; line-height:1.4; margin:7px 0 6px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.why { color:${ACCENT}; font-size:12px; line-height:1.4; display:flex; gap:5px; }
.why .wst { flex:0 0 auto; } .why b { font-weight:600; }
.meta { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top:5px; font-size:11.5px; color:#8c7d68; }
.chip { font-size:10.5px; font-weight:600; padding:2px 9px; border-radius:999px; }
.srch { flex:0 0 auto; }
.pfav { width:14px; height:14px; border-radius:3px; flex:0 0 auto; vertical-align:-3px; }
.pini { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:50%;
        flex:0 0 auto; font-size:9px; font-weight:700; color:#fff; vertical-align:-3px; }
.rcol { flex:0 0 124px; display:flex; flex-direction:column; }
.rf { font-size:11px; color:#8c7d68; } .inf { cursor:default; }
.pct { font-size:17px; font-weight:650; line-height:1.15; margin-top:5px; }
.vd { font-size:11.5px; font-weight:500; margin-top:1px; }
.acts { margin-top:12px; }
.draftb { width:100%; background:${ACCENT}; color:${INK}; border:0; border-radius:9px;
          font:600 12.5px -apple-system,system-ui,sans-serif; padding:9px 8px; cursor:pointer; }
.draftb:hover { filter:brightness(1.06); }
.lk { background:none; border:0; color:#8c7d68; font:500 12px -apple-system,system-ui,sans-serif; padding:6px 9px; border-radius:7px; cursor:pointer; white-space:nowrap; }
.lk:hover { background:#221c15; color:#cbb89c; } .lk:disabled { opacity:.6; cursor:default; } .lk.skip { margin-left:auto; }
.foot { padding:13px 14px; text-align:center; border-top:.5px solid rgba(214,154,92,.10); flex:0 0 auto; }
.foot1 { font-size:12.5px; color:#b6a892; } .foot2 { font-size:11.5px; color:#8c7d68; margin-top:2px; }
.dhl { display:flex; align-items:center; gap:11px; min-width:0; flex:1 1 auto; }
.dhgoobi { display:inline-flex; align-items:center; justify-content:center; min-width:36px; min-height:36px; flex:0 0 auto; cursor:pointer; border-radius:10px; }
.dt { min-width:0; flex:1 1 auto; }
.gcv { display:block; image-rendering:pixelated; transform-origin:bottom center; }
.g-bob { animation:g-bob 1.7s ease-in-out infinite; }
.g-snooze { animation:g-snooze 3.8s ease-in-out infinite; }
.g-wobble { animation:g-wobble 1.6s ease-in-out infinite; }
.g-tada { animation:g-tada .9s ease-in-out infinite; }
.g-trick { animation:g-trick 1.05s ease-in-out infinite; }
.g-dance { animation:g-dance .9s ease-in-out infinite; }
.g-slide { animation:g-slide 1.7s ease-in-out infinite; }
.g-wave { animation:g-wave 1.1s ease-in-out infinite; }
.g-jump { animation:g-jump .8s ease-in-out infinite; }
.g-spin { animation:g-spin .9s ease-in-out infinite; }
.g-flip { animation:g-flip .85s ease-in-out infinite; }
.g-love { animation:g-love .85s ease-in-out infinite; }
@keyframes g-trick { 0%{transform:rotate(0) translateY(0) scale(1)} 18%{transform:rotate(-12deg) translateY(-34%) scale(1.06)} 60%{transform:rotate(360deg) translateY(0) scale(1.06)} 80%{transform:rotate(360deg) translateY(-12%) scale(1)} 100%{transform:rotate(360deg) translateY(0) scale(1)} }
@keyframes g-dance { 0%{transform:translateY(0) rotate(5deg) scale(1.05,.95)} 25%{transform:translateY(-14%) rotate(2deg) scale(.95,1.05)} 50%{transform:translateY(0) rotate(-5deg) scale(1.05,.95)} 75%{transform:translateY(-14%) rotate(-2deg) scale(.95,1.05)} 100%{transform:translateY(0) rotate(5deg) scale(1.05,.95)} }
@keyframes g-slide { 0%{transform:translateX(-46%) translateY(0)} 25%{transform:translateX(-46%) translateY(-9%)} 50%{transform:translateX(46%) translateY(0)} 75%{transform:translateX(46%) translateY(-9%)} 100%{transform:translateX(-46%) translateY(0)} }
@keyframes g-wave { 0%,100%{transform:rotate(0) translateY(0)} 15%{transform:rotate(-15deg) translateY(-6%)} 35%{transform:rotate(11deg)} 55%{transform:rotate(-11deg)} 75%{transform:rotate(8deg)} }
@keyframes g-jump { 0%{transform:translateY(0) scale(1,1)} 15%{transform:translateY(0) scale(1.1,.9)} 35%{transform:translateY(-45%) scale(.94,1.08)} 50%{transform:translateY(-50%) scale(1,1)} 65%{transform:translateY(0) scale(1.1,.9)} 85%,100%{transform:translateY(0) scale(1,1)} }
@keyframes g-spin { 0%{transform:rotate(0) scale(1)} 50%{transform:rotate(180deg) scale(1.08)} 100%{transform:rotate(360deg) scale(1)} }
@keyframes g-flip { 0%{transform:translateY(0) rotate(0)} 40%{transform:translateY(-48%) rotate(-180deg)} 70%{transform:translateY(-12%) rotate(-360deg)} 100%{transform:translateY(0) rotate(-360deg)} }
@keyframes g-love { 0%,100%{transform:translateY(0) scale(1,1) rotate(0)} 25%{transform:translateY(-13%) scale(1.04,.96) rotate(-4deg)} 50%{transform:translateY(0) scale(1.07,.93)} 75%{transform:translateY(-13%) scale(1.04,.96) rotate(4deg)} }
.g-think { animation:g-think 1.5s ease-in-out infinite; }
.g-hunt { animation:g-hunt 1.1s ease-in-out infinite; }
@keyframes g-hunt { 0%{transform:translateX(-7%) translateY(0)} 25%{transform:translateX(-7%) translateY(-9%)} 50%{transform:translateX(7%) translateY(0)} 75%{transform:translateX(7%) translateY(-9%)} 100%{transform:translateX(-7%) translateY(0)} }
.g-wiggle { animation:g-wiggle .85s ease-in-out infinite; }
.g-bounce { animation:g-bounce .65s ease-in-out infinite; }
.g-heartbeat { animation:g-heartbeat 1.3s ease-in-out infinite; }
.g-float { animation:g-float 3.6s ease-in-out infinite; }
@keyframes g-think { 0%,100%{transform:translateY(0) scale(1,1)} 50%{transform:translateY(-5%) scale(1.02,1.03)} }
@keyframes g-wiggle { 0%,100%{transform:rotate(-5deg)} 50%{transform:rotate(5deg)} }
@keyframes g-bounce { 0%{transform:translateY(0) scale(1.06,.94)} 30%{transform:translateY(-34%) scale(1,1)} 50%{transform:translateY(0) scale(1.08,.92)} 68%{transform:translateY(-10%) scale(1,1)} 100%{transform:translateY(0) scale(1.06,.94)} }
@keyframes g-heartbeat { 0%,42%,100%{transform:scale(1)} 10%,30%{transform:scale(1.1)} 20%{transform:scale(1)} }
@keyframes g-float { 0%{transform:translateY(0) rotate(-2deg)} 50%{transform:translateY(-9%) rotate(2deg)} 100%{transform:translateY(0) rotate(-2deg)} }
@keyframes g-bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-9%)} }
@keyframes g-snooze { 0%,100%{transform:scale(1,1) rotate(-3deg)} 50%{transform:scale(1.03,1.06) rotate(3deg)} }
@keyframes g-wobble { 0%,100%{transform:rotate(-5deg)} 50%{transform:rotate(5deg)} }
@keyframes g-tada { 0%,100%{transform:scale(1) rotate(0)} 20%{transform:scale(1.12) rotate(-7deg)} 40%,60%,80%{transform:scale(1.14) rotate(7deg)} 50%,70%{transform:scale(1.14) rotate(-7deg)} }
.empty { color:#8c7d68; font-size:12.5px; padding:24px 16px; text-align:center; }
.paused { padding:26px 18px 22px; text-align:center; }
.pttl { font-weight:600; font-size:14px; color:#cbb89c; }
.pcopy { font-size:12px; color:#8c7d68; line-height:1.5; margin:7px 0 14px; }
/* Goobi's in-dock playground — springs open when you tap him */
.dplay { overflow:hidden; }
.dpg { padding:8px 14px 16px; }
.dpg-stage { position:relative; width:100%; box-sizing:border-box; height:128px; border-radius:14px; background:#221c15; border:1px solid rgba(214,154,92,.16); display:flex; align-items:flex-end; justify-content:center; padding-bottom:18px; cursor:pointer; color:inherit; }
.dpg-shadow { position:absolute; bottom:14px; width:46px; height:9px; background:rgba(0,0,0,.3); border-radius:50%; filter:blur(2px); }
.dpg-msg { text-align:center; font-size:12.5px; color:#cbb89c; min-height:17px; margin:11px 0 9px; }
.dpg-meter { height:9px; border-radius:6px; background:#221c15; border:.5px solid rgba(214,154,92,.12); overflow:hidden; }
.dpg-fill { height:100%; width:0%; background:linear-gradient(90deg,#f4b07e,#f4411f); border-radius:6px; transition:width .4s cubic-bezier(.34,1.56,.64,1); }
.dpg-lbl { display:flex; justify-content:space-between; font-size:10.5px; color:#8c7d68; margin-top:5px; }
.dpg-stat { text-align:center; font-size:10.5px; color:#8c7d68; margin-top:9px; }
.dpg-treats { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:14px; min-height:6px; }
.dpg-treat { position:relative; overflow:hidden; width:30px; height:30px; border-radius:50%; border:1.5px solid rgba(244,176,126,.55); cursor:pointer; background:radial-gradient(circle at 35% 30%,#f0b07e,#c25e3f); box-shadow:0 1px 3px rgba(0,0,0,.35); transition:transform .1s; }
.dpg-treat:hover { transform:scale(1.14); }
.dpg-treat:active { transform:scale(.9); }
.dpg-av { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; pointer-events:none; }
.dpg-row { display:flex; gap:8px; align-items:center; margin-top:16px; }
.dpg-hunt { flex:1; border:0; border-radius:10px; padding:10px; font:600 13px inherit; cursor:pointer; background:#3a322a; color:#8c7d68; transition:background .25s,color .25s,box-shadow .25s; }
.dpg-hunt.ready { background:linear-gradient(90deg,#f4b07e,#f4411f); color:#1a1206; box-shadow:0 4px 14px rgba(244,65,31,.35); animation:dpg-pulse 1.7s ease-in-out infinite; }
.dpg-hunt:disabled { cursor:default; }
.dpg-back { border:0; background:none; color:#8c7d68; font:600 13px inherit; cursor:pointer; padding:10px 12px; }
.dpg-back:hover { color:#cbb89c; }
.dpg-movelbl { font-size:10.5px; color:#8c7d68; margin-top:16px; }
.dpg-moves { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }
.dpg-move { border:.5px solid rgba(214,154,92,.25); background:#221c15; color:#cbb89c; border-radius:8px; font:600 10.5px -apple-system,system-ui,sans-serif; padding:5px 8px; cursor:pointer; }
.dpg-move:hover { background:rgba(214,154,92,.13); color:#f3ead9; }
@keyframes dpg-pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.03)} }
/* Meaningful copy never drops below 12px; compact metadata stays at an 11px floor. */
.mom-label,.mom-coach,.mom-cue,.ins-fact,.ins-learn,.ins-trend,.ins-ar,.ins-meta,.ins-nudge,
.idea-summary,.idea-trend,.idea-streak,.idea-loadcap,.idea-qfoot,.tg-stand,.tg-track,.tg-sughead,.tg-fresh,.tg-warn,.tg-foot,
.rf,.meta,.foot2,.ins-foot,.ins-thin,.ins-more,.dpg-lbl,.dpg-stat,.dpg-movelbl { font-size:11px; color:var(--g-subtle); }
.ideasub,.idea-why,.tg-post,.tg-warn,.tg-foot,.pcopy,.foot1 { color:var(--g-muted); }
.rel-tab { min-height:34px; border-width:1px; font-size:12px; }
.idea-quickopen,.idea-pin,.tg-x,.dpg-treat { min-width:32px; min-height:32px; }
@media (max-width: 480px) {
  .d,.d.wide { width:calc(100vw - 16px); max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); border-radius:13px; }
  .dh { padding:12px 12px 8px; align-items:center; }
  .da { gap:5px; }
  .discovery { gap:6px; padding:0 10px 8px; }
  .scanb { display:none; }
  .modes,.tabs { padding-left:10px; padding-right:10px; overflow-x:auto; }
  .day-goals { padding-left:10px; padding-right:10px; }
  .mode,.tab { flex:1 0 auto; min-width:78px; }
  .rel-tabs { padding:7px 10px; overflow-x:auto; }
  .rel-tab { flex:1 0 auto; min-width:94px; }
  .bodywrap { flex-direction:column; gap:7px; }
  .rcol { flex:0 0 auto; width:100%; flex-direction:row; align-items:center; gap:10px; }
  .rcol .acts { margin:0 0 0 auto; }
  .pct { font-size:24px; margin:0; }
  .it { padding:5px 8px; }
  .reply-summary { gap:7px; padding:8px; }
  .reply-detail { margin-left:48px; margin-right:8px; }
  .reply-draft-quick { padding:0 9px; }
  .reply-signal-grid { grid-template-columns:1fr; }
  .idea-compose { margin:2px 10px 10px; padding:12px; }
  .ideahead-top { align-items:flex-start; gap:8px; }
  .idea-head-actions .scanb { display:inline-flex; }
  .dm-add { grid-template-columns:1fr auto; }
  .dm-why-input { grid-column:1 / -1; grid-row:2; }
  .dm-add .scanb { display:inline-flex; }
  .dm-controls { flex-wrap:wrap; }
  .dm-select { flex:1 1 130px; }
  .dm-pace { margin-left:0; }
  .dm-next { align-items:flex-start; flex-wrap:wrap; }
  .dm-next-act { margin-left:auto; }
}
`;

let dockHost: HTMLElement | null = null;
let dockRoot: ShadowRoot | null = null;
/** True when the user is typing in a dock input (filter, idea editor, target-reply). Ambient
 *  re-renders (reach completions, timers, cross-tab syncs) must skip renderDock while this holds,
 *  or a full rebuild yanks the caret out from under them. (The draft-panel steer lives in a
 *  separate shadow host and is already immune.) */
function dockInputFocused(): boolean {
  const el = dockRoot?.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}
/** Map a raw broker/API error string ("anthropic 401", "bad-output", …) to something a user can act
 *  on, instead of leaking the status code. */
function friendlyErr(raw?: string): string {
  const s = (raw || "").toLowerCase();
  if (/no-key/.test(s)) return "add your Anthropic key in the side panel first";
  if (/40[13]/.test(s)) return "your Anthropic key looks invalid or expired, check it in the side panel";
  if (/429/.test(s)) return "rate limited, give it a minute and try again";
  if (/insufficient|credit|billing|402/.test(s)) return "your Anthropic account looks out of credit";
  if (/overload|529|503|500/.test(s)) return "the model is busy right now, try again in a moment";
  if (/bad-output/.test(s)) return "the model returned an unreadable response, try again";
  return raw || "something went wrong, try again";
}
function ensureDock(): ShadowRoot {
  if (dockHost?.isConnected && dockRoot) return dockRoot;
  dockHost = document.createElement("div");
  Object.assign(dockHost.style, { position: "fixed", bottom: "18px", left: "18px", zIndex: "2147483646" } as Partial<CSSStyleDeclaration>);
  dockRoot = dockHost.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(DOCK_CSS);
  dockRoot.adoptedStyleSheets = [sheet];
  trapKeys(dockHost); // same: keep X shortcuts off the dock's filter / playground inputs
  document.documentElement.appendChild(dockHost);
  return dockRoot;
}

/** Keep Goobi discoverable before consent/key setup without reading the page or starting any
 * observers. The only action opens the extension side panel from this explicit user gesture. */
function renderSetupGate(reason: string): void {
  const root = ensureDock(); root.replaceChildren();
  const button = document.createElement("button"); button.className = "l";
  button.setAttribute("aria-label", "Finish setting up Goobi");
  const face = document.createElement("span"); face.className = "lgoobi"; face.setAttribute("aria-hidden", "true");
  face.textContent = "●"; Object.assign(face.style, { width: "28px", height: "28px", borderRadius: "10px", background: ACCENT, color: INK, alignItems: "center", justifyContent: "center", fontSize: "12px" });
  const copy = document.createElement("span"); copy.className = "ltext";
  const title = document.createElement("span"); title.className = "ll1"; title.textContent = "Goobi · Finish setup";
  const sub = document.createElement("span"); sub.className = "ll2"; sub.textContent = reason;
  copy.append(title, sub); button.append(face, copy);
  button.onclick = async () => {
    const result = await send<{ ok?: boolean }>({ type: "OPEN_SIDE_PANEL" });
    if (!result?.ok) toast("Click the Goobi toolbar icon to finish setup.");
  };
  root.append(button);
}

let setupGateListener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;
function watchSetupGate(): void {
  if (setupGateListener) return;
  setupGateListener = (changes, area) => {
    if (area !== "local" || (!changes[CONFIG.X_DATA_CONSENT_KEY] && !changes[CONFIG.ANTHROPIC_KEY_KEY] && !changes[CONFIG.X_COPILOT_KEY])) return;
    void (async () => {
      const requestedOn = (await getLocal(CONFIG.X_COPILOT_KEY)) !== false;
      const consent = (await getLocal(CONFIG.X_DATA_CONSENT_KEY)) === "v1";
      const hasKey = Boolean(await getLocal(CONFIG.ANTHROPIC_KEY_KEY));
      if (!requestedOn) {
        dockHost?.remove(); dockHost = null; dockRoot = null;
        return;
      }
      if (!consent || !hasKey) {
        renderSetupGate(!consent ? "Consent still needed · open side panel" : "Anthropic key still needed · open side panel");
        return;
      }
      if (setupGateListener) chrome.storage.onChanged.removeListener(setupGateListener);
      setupGateListener = undefined;
      await boot(); // setup completed in another extension surface; activate without another X refresh
    })();
  };
  chrome.storage.onChanged.addListener(setupGateListener);
}

/* ---------- author reach (Twttr X-data API, best-effort enrichment) ---------- */

/** handle(lower) -> follower lookup. `followers` set once known; `pending`
 *  while a request is in flight; `failed` + `at` to back off transient misses. */
const authorReach = new Map<string, { followers?: number; following?: number; bio?: string; at: number; pending?: boolean; failed?: boolean }>();
const reachQueue: string[] = [];
let reachInFlight = 0;
let reachLookups = 0;            // lookup attempts this session (a failed author may retry after REACH_FAIL_TTL)
const REACH_CONCURRENCY = 4;     // gentle on the 10 req/sec budget
const REACH_CAP = 80;            // per-session ceiling — bounds cost
const REACH_FAIL_TTL = 600_000;  // re-try a failed lookup after 10 min
const reachProfileComplete = (e?: { followers?: number; following?: number; bio?: string }): boolean =>
  e?.followers != null && e.following != null && e.bio != null;

/** The known follower count for an opp's author, from a live lookup or (for
 *  search-discovered opps) the count the search response already carried. */
function knownFollowers(o: Opp): number | undefined {
  return authorReach.get(o.author.toLowerCase())?.followers ?? o.followers;
}

/** Fresh reach is live evidence, not a permanent badge. `source` records how the post entered the
 * queue; this helper rechecks the current age, known reply competition, audience band, and author
 * spread whenever the UI or drafter is about to make a Fresh claim. */
function currentFreshReach(o: Opp, now = Date.now()) {
  if (o.source !== "fresh-reach") return null;
  const handle = o.author.replace(/^@+/, "").toLowerCase();
  return freshReachCandidate({
    id: o.id, author: o.author, text: o.text, postedAt: o.postedAt,
    followers: knownFollowers(o), likes: o.likes, replies: o.replies, reposts: o.reposts,
    quotes: o.quotes, views: o.views, isReply: false,
  }, myFollowers, now, replyLog.authors[handle]);
}

function freshReachKindLabel(kind: FreshReachOpportunityKind): string {
  if (kind === "breakout") return "Breakout pace";
  if (kind === "major-early") return "Major account · early";
  return "Early + open";
}

function freshReachMetricFacts(o: Opp, live: NonNullable<ReturnType<typeof currentFreshReach>>): string[] {
  const facts = [
    `${live.ageMinutes}m old`,
    `${o.replies} ${o.replies === 1 ? "reply" : "replies"}`,
  ];
  if (o.views != null) facts.push(`${fmtCount(o.views)} views${live.signals.viewsPerMinute != null ? ` · ~${fmtCount(Math.round(live.signals.viewsPerMinute))}/min avg` : ""}`);
  if (live.signals.engagements != null) facts.push(`${fmtCount(live.signals.engagements)} likes + reposts + quotes`);
  facts.push(`${live.sizeMultiple.toFixed(1)}× your audience`);
  return facts;
}

/** Live Fresh-specific ordering. This answers comparative opportunity, not predicted impressions. */
function currentFreshOpeningScore(o: Opp, now = Date.now()): number {
  const live = currentFreshReach(o, now);
  if (!live || !freshReachContentEligible(o)) return 0;
  return freshReachOpeningScore({
    contentFit: o.score,
    observedOpportunity: live.opportunity,
    momentum: opportunityMomentum(o.id, now)?.score,
  });
}

function bestFreshOpening(items: readonly Opp[], now = Date.now()): { opp: Opp; score: number } | undefined {
  let best: { opp: Opp; score: number } | undefined;
  for (const opp of items) {
    const score = currentFreshOpeningScore(opp, now);
    if (score > 0 && (!best || score > best.score || (score === best.score && (opp.postedAt ?? 0) > (best.opp.postedAt ?? 0)))) best = { opp, score };
  }
  return best;
}

/** Queue a follower lookup for `handle` if we don't already have/aren't fetching
 *  it. Deduped, capped, and short-circuited when the X-data API isn't configured. */
function maybeFetchReach(handle?: string): void {
  if (invalidated || twttrUnconfigured || reachLookups >= REACH_CAP) return;
  const key = (handle || "").toLowerCase();
  if (!key) return;
  const e = authorReach.get(key);
  if (e && (e.pending || reachProfileComplete(e))) return;
  if (e?.failed && Date.now() - e.at < REACH_FAIL_TTL) return;
  if (reachQueue.includes(key)) return;
  reachQueue.push(key);
  pumpReach();
}

function pumpReach(): void {
  if (invalidated) { reachQueue.length = 0; return; } // context gone — don't attempt sendMessage
  while (reachInFlight < REACH_CONCURRENCY && reachQueue.length && reachLookups < REACH_CAP && !twttrUnconfigured) {
    const key = reachQueue.shift()!;
    const cur = authorReach.get(key);
    if (reachProfileComplete(cur)) continue;
    reachInFlight++; reachLookups++;
    authorReach.set(key, { ...cur, pending: true, at: Date.now() });
    void send<{ ok?: boolean; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "user", query: { username: key } })
      .then((resp) => {
        if (resp?.error === "no-twttr-config") { twttrUnconfigured = true; authorReach.delete(key); return; }
        if (resp?.error?.startsWith("budget-")) { authorReach.set(key, { failed: true, at: Date.now() }); reachLookups--; return; } // no network spent: free the cap slot, back off via the fail-TTL
        const u = resp?.ok ? parseUser(resp.data) : null;
        if (u && u.followers >= 0) authorReach.set(key, { followers: u.followers, following: u.following, bio: u.bio, at: Date.now() });
        else authorReach.set(key, { failed: true, at: Date.now() });
      })
      .catch(() => authorReach.set(key, { failed: true, at: Date.now() }))
      .then(() => schedulePersistReach())
      .finally(() => { reachInFlight--; if (!dockInputFocused()) renderDock(); pumpReach(); }); // don't rebuild the dock (losing the user's caret) mid-type; the next render picks up the reach data
  }
}

function freshnessFactor(postedAt?: number): number {
  return replyFreshness(postedAt, Date.now());
}
/** 0 = not a builder peer · 1 = reciprocal builder peer · 2 = and in your niche.
 *  From the author's fetched bio + following/followers ratio — 0 until we've pulled
 *  their profile (so it only ever lifts authors we actually know are peers). */
function builderTierFor(o: Opp): 0 | 1 | 2 {
  const e = authorReach.get(o.author.toLowerCase());
  if (!e?.bio) return 0;
  const f = e.followers ?? o.followers;
  const ratio = e.following != null && f ? e.following / Math.max(f, 1) : undefined;
  return builderTier(e.bio, xNiche, ratio);
}

let _authorSignalMemo: { key: string; accounts: ReturnType<typeof aggregateAccounts>["accounts"] } = { key: "", accounts: {} };
function authorSignals(now: number): ReturnType<typeof aggregateAccounts>["accounts"] {
  const key = `${replyLog.sent.length}:${Math.floor(now / DAY_MS)}`;
  if (_authorSignalMemo.key !== key) _authorSignalMemo = { key, accounts: aggregateAccounts(replyLog.sent, now).accounts };
  return _authorSignalMemo.accounts;
}

function recentRepliesTo(handle: string, now: number): number {
  const h = handle.replace(/^@+/, "").toLowerCase();
  const since = now - 7 * DAY_MS;
  return replyLog.sent.filter((r) => r.at >= since && r.author?.replace(/^@+/, "").toLowerCase() === h).length;
}

/** The inspectable recommendation behind both the ordering and the row copy. */
function recommendationFor(o: Opp, now = Date.now()): ReplyRecommendation {
  const handle = o.author.replace(/^@+/, "").toLowerCase();
  const reach = authorReach.get(handle);
  const history = authorSignals(now)[handle];
  return recommendReply({
    authorHandle: o.author,
    modelFit: o.score,
    postedAt: o.postedAt,
    replies: o.replies,
    authorFollowers: knownFollowers(o),
    authorFollowing: reach?.following,
    myFollowers: myFollowers || undefined,
    reachCeiling: myFollowers ? bandHiFor(myFollowers) : undefined,
    peerTier: builderTierFor(o),
    connection: connectionEvidence(relationshipMemory, learn.handle || selfHandle, o.author, now),
    history: history ? { replies: history.replies, backs: history.backs } : undefined,
    recentAuthorReplies: recentRepliesTo(o.author, now),
    lastAuthorReplyAt: replyLog.authors[handle],
    isReplyToOwnPost: o.isReplyToOwnPost,
  }, now);
}

/** Baseline recommendation value, excluding optional outcome-learning and momentum. */
function effectiveScore(o: Opp): number { return recommendationFor(o).priority; }

// The optional closed-loop tilt stays separate from the baseline recommendation logged in
// SentRecord.score. That lets fitCorr test whether the explainable policy aligns with outcomes before
// per-account payoff can reorder it. Off by default and neutral until the measured-data gates pass.
let _multMemo: { key: string; mult: Record<string, number> } = { key: "", mult: {} };
function invalidateLearnedMults(): void { _multMemo = { key: "", mult: {} }; _authorSignalMemo = { key: "", accounts: {} }; }
function learnedMults(): Record<string, number> {
  const key = `${replyLog.sent.length}:${Math.floor(Date.now() / DAY_MS)}`; // rebuild on a new reply or a day roll (settled outcomes update daily); keeps the sort comparator O(1)
  if (_multMemo.key !== key) _multMemo = { key, mult: accountRankMultipliers(replyLog.sent, Date.now()).mult };
  return _multMemo.mult;
}
/** Recommendation tilted by opt-in measured outcomes and short-lived post momentum. */
function rankScore(o: Opp, now = Date.now()): number {
  const learned = recommendationFor(o, now).priority * (learnLoopOn ? (learnedMults()[o.author.toLowerCase()] ?? 1) : 1);
  return applyMomentum(learned, opportunityMomentum(o.id, now));
}

/** An at-a-glance "reply fit" verdict for a spot, from its live effectiveScore
 *  (which already folds in fit, freshness, reach, reply-pileup, and reciprocity). */
function scoreVerdict(s: number): { label: string; color: string } {
  if (s >= 0.55) return { label: "High", color: "#6fcf7f" };   // fresh + reachable + genuine fit
  if (s >= 0.4) return { label: "Medium", color: "#e89a3c" };
  return { label: "Low", color: "#8c7d68" };                   // stale, tiny audience, or engagement bait
}

/** "Easy replies" ranking — short, answerable posts you can reply to fast and
 *  early: favors short text, a genuine question, few existing replies, freshness. */
function easyScore(o: Opp): number {
  const len = o.text.length;
  const short = len < 120 ? 1 : len < 220 ? 0.6 : 0.3;
  const question = /\?\s*$|\b(how|what|why|which|who|when|where|anyone|recommend|thoughts|favou?rite)\b/i.test(o.text) ? 1 : 0.4;
  const early = o.replies == null ? 0.7 : o.replies < 5 ? 1 : o.replies < 30 ? 0.7 : 0.3;
  const fresh = freshnessFactor(o.postedAt);
  // Still weight genuine fit so spam doesn't top the "easy" list.
  return (short * 0.38 + question * 0.3 + early * 0.22 + fresh * 0.1) * (0.55 + 0.45 * o.score);
}

type DockSort = "best" | "recent" | "reach" | "easy";
let dockSort: DockSort = "best";
type DockView = "replies" | "comments" | "ideas" | "targets" | "dms" | "growth"; // targets is a secondary drill-in; the other five are primary workspaces
let dockView: DockView = "replies";
let growthStrategyChoice: GrowthStrategyId | undefined;
let growthOwnerProblem = "";
let growthEndArmedUntil = 0;
interface IdeaSource { handle: string; id: string; text: string; likes?: number; reposts?: number; views?: number; } // the real over-performing post we remixed
interface IdeaGrade { tier: "strong" | "ok" | "weak"; lever?: string; callout?: string; fixable?: boolean; } // per-idea quality call-out from the judge (distinct from the virality band = source reach)
interface IdeaRecord {
  id: string; text: string; source: string; pattern: string; why: string;
  origin?: "seed" | "generated"; // old persisted records predate this field and are treated as generated
  shape?: Shape; // code-classified at creation — links the model's "pattern" to the measured shape table
  band?: Band; basis?: string; sortScore?: number; // honest virality (band cites the source's real rank)
  grade?: IdeaGrade;                               // the quality tier + call-out surfaced on the row
  virality?: number;                               // legacy: old persisted records render via a fallback
  src?: IdeaSource; pinned?: boolean; status: "working" | "posted";
  remindAt?: number;   // draft-and-remind: when the user asked to be nudged to ship this
  remindedAt?: number; // when the one-shot due toast fired (the chip + badge stay until acted on)
  createdAt: number; lastEditedAt: number; postedAt?: number;
  growthExperimentId?: string; growthStrategyId?: GrowthStrategyId; // stamped when shipped/matched
  publication?: IdeaPublication; // exact, unique RapidAPI match to the real post + latest measured outcome
}
let ideaQueue: IdeaRecord[] = [];          // persisted drafts queue (X_IDEAS_KEY): working drafts + shipped
const expandedIdeas = new Set<string>();   // idea ids expanded into the in-place editor (single-open)
let ideasInsightsOpen = false;             // the Post-ideas header's insight rows (explainer + batch shapes + measured signal + biggest gainer) — collapsed by default so the idea LIST gets the room
const expandedSources = new Set<string>(); // idea ids whose source-post proof is expanded
const ideaBusy = new Set<string>();        // ids currently being rewritten (per-idea steer)
const ideaUndo = new Map<string, string>(); // id → prior text, for one-level undo after a steer
const remindPickerOpen = new Set<string>(); // idea ids with the remind-me slot picker open (session)
let shippedOpen = false;                   // the collapsed "Shipped" section
let ideaSeq = 0;
let ideasLoading = false;
let ideasError: string | undefined;
let roughIdea = "";
let roughBusy = false;
let roughError: string | undefined;
let clearIdeasArmed = false;
let clearIdeasTimer: number | undefined;
let clearedSuggestions: IdeaRecord[] = [];
const IDEAS_MAX = 30;
function newIdeaId(): string { return "i" + Date.now().toString(36) + (ideaSeq++).toString(36); }

const growthStorageKey = (handle: string): string => `${CONFIG.X_GROWTH_LOOP_KEY}:${handle.replace(/^@+/, "").trim().toLowerCase()}`;
function growthActions(): TaggedGrowthAction[] {
  const replies: TaggedGrowthAction[] = replyLog.sent.flatMap((r) => r.growthExperimentId && r.growthStrategyId ? [{ at: r.at, experimentId: r.growthExperimentId, strategyId: r.growthStrategyId, kind: "reply" as const, confirmed: isConfirmedReply(r) }] : []);
  const posts: TaggedGrowthAction[] = ideaQueue.flatMap((i) => i.postedAt && i.growthExperimentId && i.growthStrategyId ? [{ at: i.postedAt, experimentId: i.growthExperimentId, strategyId: i.growthStrategyId, kind: "post" as const, confirmed: !!i.publication }] : []);
  return [...replies, ...posts];
}
function growthExperimentAt(at: number): GrowthExperiment | undefined {
  return growthStore.experiments.find((e) => at >= e.startedAt && at <= (e.endedAt ?? e.endsAt));
}
function tagIdeaGrowth(rec: IdeaRecord, at = rec.postedAt ?? Date.now()): boolean {
  if (rec.growthExperimentId) return false;
  const gx = growthExperimentAt(at); if (!gx) return false;
  rec.growthExperimentId = gx.id; rec.growthStrategyId = gx.strategyId; return true;
}
async function persistGrowth(snapshot: GrowthStore = growthStore): Promise<void> {
  if (!snapshot.ownerHandle) return;
  const key = growthStorageKey(snapshot.ownerHandle);
  const stored = await getLocal(key) as GrowthStore | undefined;
  growthStore = mergeGrowthStores(stored, snapshot, snapshot.ownerHandle, Date.now());
  safeSet({ [key]: growthStore });
}
function captureGrowthData(now = Date.now()): void {
  if (growthOwnerProblem) return;
  const owner = growthStore.ownerHandle || learn.handle || selfHandle;
  if (!owner) return;
  const posts = (ownStats ?? []).flatMap((p) => p.postedAt ? [{ id: p.id, day: dayKey(p.postedAt), postedAt: p.postedAt, views: p.views, likes: p.likes, reposts: p.reposts, replies: p.replies }] : []);
  growthStore = captureGrowthSnapshot(growthStore, owner, now, dayKey(now), myFollowers || undefined, posts);
  let ideaChanged = false;
  for (const idea of ideaQueue) if (idea.status === "posted" && idea.postedAt) ideaChanged = tagIdeaGrowth(idea, idea.postedAt) || ideaChanged;
  const settled = settleGrowthExperiments(growthStore, growthActions(), now);
  growthStore = settled.store;
  if (ideaChanged) persistIdeas();
  void persistGrowth();
}
async function ensureGrowthOwner(): Promise<void> {
  const configured = await myHandle();
  const session = getSelf() || selfHandle;
  if (configured && session && configured.toLowerCase() !== session.toLowerCase()) {
    growthOwnerProblem = `Goobi is configured for @${configured}, but this X session is @${session}. Match the handle in the side panel before tracking growth.`;
    growthStore = freshGrowthStore("");
    return;
  }
  const owner = configured || session;
  if (!owner) {
    growthOwnerProblem = "Open Goobi while signed into X, or set your X handle in the side panel, before starting a growth test.";
    growthStore = freshGrowthStore("");
    return;
  }
  growthOwnerProblem = "";
  const stored = await getLocal(growthStorageKey(owner)) as GrowthStore | undefined;
  growthStore = mergeGrowthStores(growthStore, stored, owner, Date.now());
  if (learn.handle.toLowerCase() === owner.toLowerCase()) for (const sn of Object.values(learn.snaps)) {
    if (sn.followers == null) continue;
    const at = new Date(`${sn.day}T12:00:00`).getTime();
    if (Number.isFinite(at)) growthStore = seedFollowerSnapshot(growthStore, owner, sn.day, at, sn.followers, Date.now());
  }
  captureGrowthData();
}
function profileStateForCurrentOwner(): ProfileState | undefined {
  const owner = (growthStore.ownerHandle || learn.handle || selfHandle).replace(/^@+/, "").toLowerCase();
  const measured = (profileState?.ownerHandle || "").replace(/^@+/, "").toLowerCase();
  return owner && measured === owner ? profileState : undefined;
}
function persistIdeas(): void {
  if (ideaQueue.length > IDEAS_MAX) { // prune oldest, keeping working over posted
    ideaQueue.sort((a, b) => (a.status === "working" ? 1 : 0) - (b.status === "working" ? 1 : 0) || a.createdAt - b.createdAt);
    ideaQueue = ideaQueue.slice(ideaQueue.length - IDEAS_MAX);
  }
  safeSet({ [CONFIG.X_IDEAS_KEY]: ideaQueue });
}

/** Attribute ideas to real own posts without another API call. Exact unique text only: no fuzzy
 * guess is allowed to move a draft or teach the generator. Returns true when history changed. */
function reconcileIdeasWithOwnPosts(now = Date.now()): boolean {
  if (!ownStats?.length || !ideaQueue.length) return false;
  const result = reconcileIdeaPublications(ideaQueue, ownStats, now);
  if (!result.changed) return false;
  ideaQueue = result.ideas;
  for (const idea of ideaQueue) if (idea.status === "posted" && idea.postedAt) tagIdeaGrowth(idea, idea.postedAt);
  persistIdeas();
  if (result.matched) toast(`${result.matched === 1 ? "A post" : `${result.matched} posts`} matched on X — outcome tracking is now live.`);
  return true;
}

/** Turn one user-owned seed into one editable post. This intentionally reuses the
 * existing scoped rewrite message: no niche search, source attribution, or new
 * background capability is needed. */
async function polishRoughIdea(): Promise<void> {
  const seed = roughIdea.trim();
  if (!seed || roughBusy) return;
  roughBusy = true; roughError = undefined; renderDock();
  goobiDrafting = true; refreshGoobi();
  try {
    const resp = await send<{ text?: string; error?: string }>({
      type: "POST_IDEA_REWRITE",
      text: seed,
      steer: "Turn this rough idea into one polished, publish-ready X post in my voice. Preserve my actual point and any concrete details. Make the hook clear and the writing concise. Do not invent facts, numbers, experiences, or claims.",
    });
    if (resp?.error === "no-key") { roughError = "Add your Anthropic key in the Goobi panel to polish this idea."; return; }
    if (!resp?.text?.trim()) { roughError = resp?.error ? `Couldn't polish it: ${friendlyErr(resp.error)}` : "Couldn't polish that idea. Try adding a little more detail."; return; }
    const now = Date.now();
    const rec: IdeaRecord = {
      id: newIdeaId(), text: resp.text.trim(), source: "Your rough idea", pattern: "original thought",
      why: "Built from your rough idea — edit anything before you post.", shape: classifyShape(resp.text),
      band: "Niche", basis: "Your original idea — no reach prediction until it ships.",
      origin: "seed", status: "working", createdAt: now, lastEditedAt: now,
    };
    ideaQueue = [rec, ...ideaQueue]; roughIdea = ""; persistIdeas();
    expandedIdeas.clear(); expandedIdeas.add(rec.id);
  } catch {
    roughError = "Couldn't polish this yet. Your rough idea is still here.";
  } finally {
    roughBusy = false; goobiDrafting = false; refreshGoobi(); renderDock();
  }
}

function clearWorkingIdeas(): void {
  const removable = ideaQueue.filter((i) => i.status === "working" && i.origin !== "seed");
  if (!removable.length) return;
  if (!clearIdeasArmed) {
    clearIdeasArmed = true; renderDock();
    if (clearIdeasTimer) clearTimeout(clearIdeasTimer);
    clearIdeasTimer = window.setTimeout(() => { clearIdeasArmed = false; clearIdeasTimer = undefined; renderDock(); }, 5000);
    return;
  }
  if (clearIdeasTimer) clearTimeout(clearIdeasTimer);
  clearIdeasTimer = undefined; clearIdeasArmed = false;
  clearedSuggestions = removable;
  ideaQueue = ideaQueue.filter((i) => i.status === "posted" || i.origin === "seed");
  expandedIdeas.clear(); expandedSources.clear(); ideaUndo.clear(); persistIdeas(); renderDock();
  toast("Suggestions cleared. Your drafts and posted history are safe.");
}

function undoClearSuggestions(): void {
  if (!clearedSuggestions.length) return;
  ideaQueue = [...clearedSuggestions, ...ideaQueue]; clearedSuggestions = []; persistIdeas(); renderDock();
  toast("Suggestions restored.");
}
let goobiIdeasHandle: GoobiHandle | null = null; // the big dancing Goobi shown while ideas generate
let goobiIdeasTimer: number | undefined;
let kebabOpen = false; // the ⋮ overflow menu (Pause / Find spots / Clear all)
// Relationship analytics stay secondary. The actionable reply/mention queue is now the top-level
// Comments workspace; this accordion only holds who-you-show-up-with / who-shows-up-for-you.
type RelTab = "invest" | "supporters" | null;
// Collapsed by DEFAULT so the reply-spots list is visible the moment you open the dock — the count
// badges do the notifying; you tap a tab only when you want its body. (Open-by-default pushed the
// reply queue off-screen.)
let relTab: RelTab = null;
let todayOpen = false; // the Today strip's full detail (cue/shape/dots/callout) — collapsed to summary+coach by default
let threadsAll = false; // tend-your-threads: false = top 3 rows (the dock is a queue, not a ledger), true = the full ranked 8
let relationshipsOpen = false; // secondary relationship analytics stay behind one compact disclosure
let replyToolsOpen = false;    // sort + filter are contextual tools, not permanent chrome

let goobiReactUntil = 0;                          // transient reaction window (happy/cheer)
let goobiReactMood: GoobiMood = "happy";
let goobiReactCopy: [string, string] = ["Nice reply!", "that's the good stuff"];
let goobiSearchUntil = 0;                         // "searching" window after a manual rescan
let goobiLastSeen = 0;                            // last active use (persisted)
let goobiWelcomeBack = false;                     // set at boot when you've been away a while
let goobiDrafting = false;                        // a reply is being drafted (Claude)
let goobiDockHandle: GoobiHandle | null = null;   // the live dock/pill Goobi, for in-place mood updates
const DAY_MS = 24 * HOUR_MS;

function replyPaceEvents(): ReplyPaceEvent[] {
  const laneByAt = new Map(replyLog.sent.filter((record) => record.lane).map((record) => [record.at, record.lane]));
  return replyLog.times.map((at) => ({ at, lane: laneByAt.get(at) }));
}

/** One shared adaptive status for scanning, Targets, the dock chip, Goobi, and nudges. */
function currentReplyPace(now = Date.now()): ReplyPaceStatus {
  return replyPaceStatus(replyPaceEvents(), now, paceResetAt || undefined);
}

function resetReplyPace(): void {
  paceResetAt = Date.now();
  safeSet({ [CONFIG.X_PACE_RESET_KEY]: paceResetAt });
  manualScanUntil = paceResetAt + 2 * 60_000;
  toast("Goobi's local pace meter reset. Reply history, duplicate checks, daily progress, and X's own limits were not reset.");
  renderDock();
  requestScan();
}

/** Consecutive days (ending today, or yesterday if today's still empty) with >=1 reply. */
function replyStreak(): number {
  let s = 0;
  for (let i = (replyLog.daily[dayKey(Date.now())] ? 0 : 1); ; i++) {
    if ((replyLog.daily[dayKey(Date.now() - i * DAY_MS)] || 0) > 0) s++;
    else break;
  }
  return s;
}

/** Mark Goobi as actively used now (persisted) so the neglect/welcome-back beat resets. */
function touchGoobi(): void {
  goobiLastSeen = Date.now();
  safeSet({ [CONFIG.X_GOOBI_SEEN_KEY]: goobiLastSeen });
}

/** Fire a transient Goobi reaction (happy/cheer) with its own status copy, then settle. */
function goobiReact(mood: GoobiMood, line: string, sub: string, ms: number): void {
  goobiReactUntil = Date.now() + ms; goobiReactMood = mood; goobiReactCopy = [line, sub];
  renderDock();
  setTimeout(() => { if (Date.now() >= goobiReactUntil) renderDock(); }, ms + 100);
}

/** The reply reaction: a big happy cheer (^‿^ tada) that melts into heart-eyed love. */
function goobiReactLove(line: string, sub: string, ms: number): void {
  goobiReactUntil = Date.now() + ms; goobiReactMood = "cheer"; goobiReactCopy = [line, sub];
  renderDock();
  setTimeout(() => { if (Date.now() < goobiReactUntil) { goobiReactMood = "love"; refreshGoobi(); } }, 1100); // cheer → love
  setTimeout(() => { if (Date.now() >= goobiReactUntil) renderDock(); }, ms + 100);
}

/** Goobi's mood from real dock signals: he naps when nothing's going on, looks
 *  around while searching, beams when you reply, and goes woozy when you're hot. */
function goobiMood(): GoobiMood {
  const now = Date.now();
  if (now < goobiReactUntil) return goobiReactMood;               // just reacted (happy/cheer)
  if (goobiDrafting) return "thinking";                           // drafting a reply
  if (findingSpots) return "searching";                           // hunting for new posts (API search)
  if (inFlight.size > 0) return "thinking";                       // analyzing posts (Claude scoring)
  if (now < goobiSearchUntil) return "searching";                 // just hit rescan
  if (currentReplyPace(now).level === "easeoff") return "worn";  // adaptive ease-off — honest mirror
  return opps.size > 0 ? "idle" : "sleeping";                     // posts waiting vs all quiet
}

/** Update the live dock Goobi's mood in place (no full re-render) — for working
 *  states that flip rapidly: searching, analyzing, drafting. */
function refreshGoobi(): void { goobiDockHandle?.setMood(goobiMood()); }

/** Goobi's mood + status copy — shared by the dock header face, the minimized
 *  launcher, and tooltips. */
function goobiStatus(): { mood: GoobiMood; line: string; sub: string } {
  const n = opps.size;
  const mood = goobiMood();
  const reacting = Date.now() < goobiReactUntil;
  const COPY: Record<GoobiMood, [string, string]> = {
    searching: ["Sniffing out posts…", "one sec"],
    thinking:  ["Reading the posts…", "thinking it over"],
    happy:     ["Nice reply!", "that's the good stuff"],
    cheer:     ["Nice!", "love that"],
    trick:     ["Ta-da! 🎪", "he did a trick"],
    love:      ["Love it!", "that's the good stuff"],
    worn:      ["Let's ease off", "you're going fast — give it a minute"],
    idle:      [`${n} ${n === 1 ? "post" : "posts"} to reply to`, "tap me to hunt for more"],
    sleeping:  ["All quiet", "tap me to go hunting"],
  };
  const [line, sub] = reacting ? goobiReactCopy : COPY[mood];
  return { mood, line, sub };
}

function topOpps(): Opp[] {
  const f = dockFilter.toLowerCase();
  const list = [...opps.values()].filter((o) => !f || o.author.toLowerCase().includes(f) || o.text.toLowerCase().includes(f) || (o.name || "").toLowerCase().includes(f));
  const now = Date.now();
  const freshScores = new Map(list.map((o) => [o.id, currentFreshOpeningScore(o, now)]));
  const key = (o: Opp): number =>
    dockSort === "recent" ? (o.postedAt ?? 0) :
    dockSort === "reach" ? ((freshScores.get(o.id) || 0) > 0 ? 1 + freshScores.get(o.id)! : recommendationFor(o, now).discovery) :
    dockSort === "easy" ? easyScore(o) :
    rankScore(o, now); // "best" = fit + proven account tilt + measured post momentum (both neutral when absent)
  list.sort((a, b) => key(b) - key(a));
  // Fresh Reach is a first-class decision surface. On Best, pin the strongest live opening once;
  // other sorts remain literal. Reach already uses the same opening index as its primary key.
  if (dockSort === "best") {
    const best = bestFreshOpening(list, now);
    if (best) {
      const index = list.findIndex((o) => o.id === best.opp.id);
      if (index > 0) list.unshift(...list.splice(index, 1));
    }
  }
  return list.slice(0, 25);
}

/** Category chip colors, keyed to the reply angle. */
function catColor(id?: string): { bg: string; fg: string } {
  switch (id) {
    case "connect": case "support": return { bg: "rgba(79,174,106,.16)", fg: "#6fcf7f" };
    case "value": return { bg: "rgba(127,119,221,.20)", fg: "#a99cf0" };
    case "ask": return { bg: "rgba(214,154,92,.18)", fg: "#e0a45c" };
    case "joke": return { bg: "rgba(237,147,177,.18)", fg: "#ed93b1" };
    default: return { bg: "rgba(214,154,92,.16)", fg: "#d69a5c" }; // promote / reply
  }
}
/** A colored initial circle when no avatar image is available. */
function avInitial(o: Opp): HTMLElement {
  const s = document.createElement("span"); s.className = "av init";
  const n = o.name || o.author || "·";
  s.textContent = (n.trim()[0] || "·").toUpperCase();
  let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  s.style.background = `hsl(${h % 360} 50% 42%)`;
  return s;
}
/** Small colored-initial circle for the launcher's overlapping avatar stack. */
function lavInitial(o: Opp): HTMLElement {
  const s = document.createElement("span"); s.className = "lav lavinit";
  const nm = o.name || o.author || "·";
  s.textContent = (nm.trim()[0] || "·").toUpperCase();
  let h = 0; for (let i = 0; i < nm.length; i++) h = (h * 31 + nm.charCodeAt(i)) >>> 0;
  s.style.background = `hsl(${h % 360} 50% 42%)`;
  return s;
}
/** The overlapping avatar stack on the launcher pill — top reply-spot authors, faces
 *  first, so the minimized dock reads like "these people are worth replying to". */
function launcherAvatars(): HTMLElement | null {
  const now = Date.now();
  const ranked = [...opps.values()].sort((a, b) => rankScore(b, now) - rankScore(a, now));
  if (!ranked.length) return null;
  const shown = ranked.slice(0, 4);
  const avs = document.createElement("span"); avs.className = "lavs";
  shown.forEach((o, i) => {
    let node: HTMLElement;
    if (o.avatar) {
      const im = document.createElement("img"); im.className = "lav"; im.src = o.avatar; im.alt = ""; im.referrerPolicy = "no-referrer";
      im.title = o.name || `@${o.author}`;
      im.onerror = () => { const fb = lavInitial(o); fb.style.zIndex = im.style.zIndex; im.replaceWith(fb); };
      node = im;
    } else { node = lavInitial(o); node.title = o.name || `@${o.author}`; }
    node.style.zIndex = String(10 - i); // earlier (better) faces sit on top
    avs.append(node);
  });
  const extra = ranked.length - shown.length;
  if (extra > 0) { const more = document.createElement("span"); more.className = "lav lmore"; more.textContent = `+${extra}`; avs.append(more); }
  return avs;
}

function renderList(list: HTMLElement) {
  list.replaceChildren();
  const items = topOpps();
  if (!items.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = opps.size ? "No posts match that filter." : "Scroll your feed — posts worth replying to collect here.";
    list.appendChild(e);
    return;
  }
  const hero = dockSort === "best" || dockSort === "reach" ? bestFreshOpening(items) : undefined;
  for (const o of items) {
    maybeFetchReach(o.author); // enrich with the author's real follower count (best-effort)
    const rec = recommendationFor(o);
    const liveFresh = currentFreshReach(o);
    const open = expandedReplyCards.has(o.id);
    const isFreshHero = hero?.opp.id === o.id;
    const card = document.createElement("div"); card.className = "it reply-card" + (open ? " open" : "") + (isFreshHero ? " fresh-hero" : "") + (o.isReplyToOwnPost ? " inbound-own-post" : "");
    const toggle = () => { const wasOpen = expandedReplyCards.has(o.id); expandedReplyCards.clear(); if (!wasOpen) expandedReplyCards.add(o.id); renderDock(); };
    const draftNow = () => void draftFor({ author: o.author, text: o.text, context: o.context, oppId: o.id, angle: initialAngle(o.category), avatar: o.avatar, products: o.products, name: o.name, isReplyToOwnPost: o.isReplyToOwnPost });
    const laneColor = rec.lane === "inbound" || rec.lane === "continue" ? "#6fcf7f" : rec.lane === "community" ? "#5dcaa5" : ACCENT;
    const age = fmtAge(o.postedAt);
    const strength = rec.strength === "best next" ? "Best next" : rec.strength === "good option" ? "Good" : "Later";

    if (o.isReplyToOwnPost) {
      const inboundHead = document.createElement("div"); inboundHead.className = "reply-inbound-banner";
      inboundHead.setAttribute("role", "note"); inboundHead.setAttribute("aria-label", `@${o.author} replied to one of your posts`);
      const inboundTitle = document.createElement("span"); inboundTitle.className = "reply-inbound-kicker"; inboundTitle.textContent = "↩ They replied to your post";
      const inboundExplain = document.createElement("span"); inboundExplain.className = "reply-inbound-explain"; inboundExplain.textContent = "Reply back in your thread";
      inboundHead.append(inboundTitle, inboundExplain); card.append(inboundHead);
    }
    if (isFreshHero && liveFresh) {
      const heroHead = document.createElement("div"); heroHead.className = "fresh-hero-head";
      const heroCopy = document.createElement("div");
      const heroTitle = document.createElement("div"); heroTitle.className = "fresh-hero-title";
      heroTitle.textContent = liveFresh.kind === "breakout" ? "🚀 Best measured breakout opening now"
        : liveFresh.kind === "major-early" ? "⚡ Best major-account opening now"
          : "⚡ Best observed reach opening now";
      const heroSub = document.createElement("div"); heroSub.className = "fresh-hero-sub";
      heroSub.textContent = `${freshReachKindLabel(liveFresh.kind)} · ${freshReachMetricFacts(o, liveFresh).join(" · ")} · ${Math.round(o.score * 100)} content fit`;
      const band = document.createElement("span"); band.className = "fresh-hero-band"; band.textContent = `${freshReachOpeningBand(hero.score)} opening`;
      band.title = "Comparative Goobi opportunity index from content fit, timing, thread room, audience fit, author spread, and bounded measured momentum. Not an impression forecast.";
      heroCopy.append(heroTitle, heroSub); heroHead.append(heroCopy, band); card.append(heroHead);
    }
    const summary = document.createElement("div"); summary.className = "reply-summary";
    const summaryToggle = document.createElement("div"); summaryToggle.className = "reply-toggle"; summaryToggle.setAttribute("role", "button"); summaryToggle.tabIndex = 0; summaryToggle.setAttribute("aria-expanded", String(open)); summaryToggle.title = open ? "Collapse reply details" : "Show why Goobi recommends this reply";
    summaryToggle.onclick = toggle;
    summaryToggle.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
    if (o.avatar) {
      const av = document.createElement("img"); av.className = "av"; av.src = o.avatar; av.alt = ""; av.loading = "lazy"; av.referrerPolicy = "no-referrer"; av.onerror = () => av.replaceWith(avInitial(o)); summaryToggle.append(av);
    } else summaryToggle.append(avInitial(o));
    const copy = document.createElement("div"); copy.className = "reply-copy";
    const identity = document.createElement("div"); identity.className = "reply-id";
    const nm = document.createElement("div"); nm.className = "nm";
    const ns = document.createElement("span"); ns.className = "nmt"; ns.textContent = o.name || `@${o.author}`; ns.title = `@${o.author}`; nm.append(ns);
    if (o.verified) { const vb = document.createElement("span"); vb.className = "vf"; vb.textContent = "✓"; vb.title = "Verified account"; nm.append(vb); }
    const fc = knownFollowers(o); if (fc) { const fcs = document.createElement("span"); fcs.className = "fc"; fcs.textContent = `${fmtCount(fc)} followers`; nm.append(fcs); }
    identity.append(nm); copy.append(identity);
    const compactMeta = document.createElement("div"); compactMeta.className = "reply-compact-meta";
    const lane = document.createElement("span"); lane.className = "reply-lane"; lane.style.color = laneColor; lane.textContent = rec.laneLabel;
    const strengthEl = document.createElement("span"); strengthEl.className = "reply-strength"; strengthEl.style.color = laneColor; strengthEl.style.background = `${laneColor}1f`; strengthEl.textContent = strength;
    compactMeta.append(lane, strengthEl);
    if (rec.authorRepeat) { const repeat = document.createElement("span"); repeat.className = "reply-repeat"; repeat.textContent = `↻ replied ${rec.authorRepeat.label}`; repeat.title = rec.cautions[0] || "Recent reply to this author lowers all recommendation scores."; compactMeta.append(repeat); }
    if (age) { const ageEl = document.createElement("span"); ageEl.className = "reply-age"; ageEl.textContent = `· ${age}`; compactMeta.append(ageEl); }
    if (o.source === "fresh-reach") {
      const hunted = document.createElement("span"); hunted.className = "reply-age"; hunted.style.color = liveFresh ? "#e0a45c" : "#8c7d68"; hunted.textContent = liveFresh ? "· ⚡ fresh reach" : "· ⚡ hunt · cooled"; hunted.title = liveFresh
        ? `${freshReachKindLabel(liveFresh.kind)}. Observed now: ${freshReachMetricFacts(o, liveFresh).join(" · ")}. Goobi thresholds are tunable heuristics, not X guarantees.`
        : "Found by Fresh reach, but it is no longer inside Goobi's strict live window. The card stays available without an urgency claim.";
      compactMeta.append(hunted);
    }
    const rising = opportunityMomentum(o.id);
    const isRising = !!rising && rising.score >= 0.25 && o.postedAt != null && Date.now() - o.postedAt <= 2 * HOUR_MS && slotOdds(o.replies) > 0.45;
    if (isRising) { const up = document.createElement("span"); up.style.color = "#6fcf7f"; up.textContent = "↗ picking up"; compactMeta.append(up); }
    const excerpt = document.createElement("div"); excerpt.className = "reply-compact-text"; excerpt.textContent = o.text;
    copy.append(compactMeta, excerpt); summaryToggle.append(copy);

    const quick = document.createElement("div"); quick.className = "reply-summary-actions";
    const draft = document.createElement("button"); draft.className = "reply-draft-quick"; draft.textContent = o.isReplyToOwnPost ? "Reply back" : "Draft"; draft.title = o.isReplyToOwnPost ? `Draft a reply to @${o.author}'s comment on your post` : `Draft a ${catLabel(o.category).toLowerCase()} reply in your voice`; draft.onclick = draftNow;
    const disclose = document.createElement("button"); disclose.className = "reply-disclose"; disclose.textContent = open ? "▴" : "▾"; disclose.setAttribute("aria-label", open ? "Collapse reply details" : "Expand reply details"); disclose.setAttribute("aria-expanded", String(open)); disclose.onclick = toggle;
    quick.append(draft, disclose); summary.append(summaryToggle, quick); card.append(summary);

    if (open) {
      const detail = document.createElement("div"); detail.className = "reply-detail";
      const meta = document.createElement("div"); meta.className = "meta"; meta.style.marginTop = "0";
      if (o.isReplyToOwnPost) { const own = document.createElement("span"); own.className = "chip"; own.style.background = "rgba(111,207,127,.14)"; own.style.color = "#8bd397"; own.textContent = "↩ They replied to your post"; own.title = "X shows this post as replying directly to your account. Goobi prioritizes it as warm inbound conversation."; meta.append(own); }
      if (o.source === "fresh-reach") {
        const s = document.createElement("span"); s.className = "srch"; s.textContent = liveFresh ? `${liveFresh.kind === "breakout" ? "🚀" : "⚡"} ${freshReachKindLabel(liveFresh.kind)}` : "⚡ Fresh reach · cooled"; s.title = liveFresh
          ? "Observed eligibility under Goobi's current heuristics: relevant content, a larger account, live public distribution/timing evidence, and bounded reply competition. It is not a reach prediction."
          : "This came from the Fresh reach hunt but no longer passes its live timing/competition screen."; meta.append(s);
      } else if (o.source === "search") { const s = document.createElement("span"); s.className = "srch"; s.textContent = "🔎 Found by niche search"; s.title = "This post is not currently rendered on your X page."; meta.append(s); }
      if (o.category) { const cc = catColor(o.category); const ct = document.createElement("span"); ct.className = "chip"; ct.style.background = cc.bg; ct.style.color = cc.fg; ct.textContent = `${catLabel(o.category)} angle`; meta.append(ct); }
      const btier = builderTierFor(o);
      if (btier) { const bc = document.createElement("span"); bc.className = "chip"; bc.style.background = "rgba(93,202,165,.16)"; bc.style.color = "#5dcaa5"; bc.textContent = btier === 2 ? "Peer in your space" : "Peer builder"; bc.title = "A relevant builder peer—useful for community-building when the post itself is a genuine fit."; meta.append(bc); }
      const connection = connectionEvidence(relationshipMemory, learn.handle || selfHandle, o.author, Date.now());
      if (connection?.established) { const rc = document.createElement("span"); rc.className = "chip"; rc.style.background = "rgba(111,207,127,.12)"; rc.style.color = "#8bd397"; rc.textContent = "↔ Ongoing connection"; rc.title = `You directly answered ${connection.completed} of @${o.author}'s replies across ${connection.activeWeeks} weeks on this device.`; meta.append(rc); }
      if (isRising && rising) { const rc = document.createElement("span"); rc.className = "chip"; rc.style.background = "rgba(111,207,127,.14)"; rc.style.color = "#6fcf7f"; rc.textContent = "↗ Picking up"; const pace = rising.viewsPerHour != null ? `~${fmtCount(Math.round(rising.viewsPerHour))} views/hr` : `~${fmtCount(Math.round(rising.engagementsPerHour ?? 0))} engagements/hr`; rc.title = `Measured from two public snapshots: ${pace}. This only gives a mild Best-sort lift.`; meta.append(rc); }
      if (o.category === "promote") for (const p of o.products || []) { const ic = faviconImg(p.url) || letterAvatar(p.name); ic.title = p.name; meta.append(ic); }
      if (meta.childNodes.length) detail.append(meta);

      const post = document.createElement("div"); post.className = "reply-post"; post.textContent = o.text; if (meta.childNodes.length) post.style.marginTop = "8px"; detail.append(post);
      if (o.replyBrief) {
        const move = document.createElement("div"); move.className = "reply-why-card";
        const moveLabel = document.createElement("div"); moveLabel.className = "reply-section-label"; moveLabel.textContent = "Best contribution";
        const moveText = document.createElement("div"); moveText.className = "reply-why-line"; moveText.textContent = o.replyBrief;
        move.append(moveLabel, moveText);
        if (o.anchor) { const anchor = document.createElement("div"); anchor.className = "reply-evidence"; anchor.textContent = `Engage this exact detail: ${o.anchor}`; move.append(anchor); }
        detail.append(move);
      }
      if (rec.authorRepeat) { const warning = document.createElement("div"); warning.className = "reply-repeat-warning"; warning.textContent = o.isReplyToOwnPost
        ? `Already replied to @${o.author} ${rec.authorRepeat.label}. This is a direct comment on your post, so Goobi kept it important as an ongoing conversation. Reply only if you have something useful to add.`
        : `Already replied to @${o.author} ${rec.authorRepeat.label}. Goobi lowered all three scores to encourage account spread; continue only for a real ongoing conversation.`; detail.append(warning); }
      const why = document.createElement("div"); why.className = "reply-why-card";
      const whyLabel = document.createElement("div"); whyLabel.className = "reply-section-label"; whyLabel.textContent = "Why this is worth your time"; why.append(whyLabel);
      const reasons = [...new Set([...rec.reasons, o.reason].filter(Boolean))].slice(0, 3);
      for (const reason of reasons) { const line = document.createElement("div"); line.className = "reply-why-line"; const dot = document.createElement("span"); dot.className = "reply-why-dot"; dot.textContent = "◆"; const text = document.createElement("span"); text.textContent = reason; line.append(dot, text); why.append(line); }
      detail.append(why);
      if (o.source === "fresh-reach") {
        const coach = document.createElement("div"); coach.className = "reply-evidence";
        coach.textContent = !liveFresh
          ? "The original Fresh window has cooled. Reply only if the post still deserves a specific contribution; Goobi is no longer claiming a timing or competition advantage."
          : premiumTier === "premium+" || premiumTier === "premium"
            ? `Your ${premiumTier === "premium+" ? "Premium+" : "Premium"} reply may receive X's documented conversation-ranking preference. That is not a For You or impressions guarantee: write for surrounding readers, add one concrete point, and skip if you have nothing specific.`
            : "The observed opportunity is timing plus audience fit, not a loophole. Write for surrounding readers, add one concrete point, and skip if you have nothing specific.";
        detail.append(coach);
        if (liveFresh) {
          const observed = document.createElement("div"); observed.className = "reply-evidence";
          observed.textContent = `${freshReachKindLabel(liveFresh.kind)} · ${freshReachMetricFacts(o, liveFresh).join(" · ")} · distribution evidence ${Math.round(liveFresh.signals.distributionScore * 100)}/100. Rechecked when this card renders; pace is an average since posting, not a forecast.`;
          detail.append(observed);
        }
      }

      const signals = document.createElement("div"); signals.className = "reply-signal-grid"; signals.title = "Decision signals, not predicted X probabilities.";
      const signalWhy: Record<string, string> = {
        Reach: "\u2726 Algo prior: fit \u00d7 freshness \u00d7 thread room \u00d7 audience size, over live public data. Directional, not a reach prediction.",
        Relationship: "Your logged history with this account when it exists (\u2713 measured: replies, engage-backs, completed connections); otherwise a peer-tier prior (\u2726).",
        Community: "\u2726 Algo prior: relevant-peer signals (niche/bio match, plausible reciprocity).",
      };
      ([['Reach', rec.discovery, ACCENT], ['Relationship', rec.relationship, '#6fcf7f'], ['Community', rec.community, '#5dcaa5']] as Array<[string, number, string]>).forEach(([label, value, color]) => {
        const signal = document.createElement("div"); signal.className = "reply-signal";
        signal.title = signalWhy[label] ?? "";
        const signalTop = document.createElement("div"); signalTop.className = "reply-signal-top"; const l = document.createElement("span"); l.textContent = label; const n = document.createElement("b"); n.textContent = String(Math.round(value * 100)); signalTop.append(l, n);
        const track = document.createElement("div"); track.className = "reply-signal-track"; const fill = document.createElement("span"); fill.className = "reply-signal-fill"; fill.style.width = `${Math.round(value * 100)}%`; fill.style.background = color; track.append(fill); signal.append(signalTop, track); signals.append(signal);
      });
      detail.append(signals);
      const evidence = document.createElement("div"); evidence.className = "reply-evidence"; evidence.textContent = `${rec.confidence}${rec.cautions[0] ? ` · ${rec.cautions[0]}` : ""} · Signals guide prioritization; they do not predict reach.`; detail.append(evidence);

      const actions = document.createElement("div"); actions.className = "reply-detail-actions";
      const action = (label: string, run: () => void, remove = false) => { const b = document.createElement("button"); b.className = "reply-action" + (remove ? " remove" : ""); b.textContent = label; b.onclick = run; return b; };
      const openX = action("Open on X ↗", () => window.open(`https://x.com/${o.author}/status/${o.id}`, "_blank", "noopener"));
      const follow = action(followed.has(o.author) ? "✓ Following" : "+ Follow", () => { void (async () => {
        if (followed.has(o.author)) return; follow.disabled = true; follow.textContent = "Following…";
        const result = await followAuthor(findPost(o.id, o.source === "feed" ? o.text : undefined));
        if (result === "followed") { followed.add(o.author); follow.textContent = "✓ Following"; toast(`Followed @${o.author}.`); touchGoobi(); goobiReact("happy", "New friend!", `following @${o.author}`, 2000); }
        else if (result === "already") { followed.add(o.author); follow.textContent = "✓ Following"; toast(`Already following @${o.author}.`); }
        else if (result === "paced") { follow.disabled = false; follow.textContent = "+ Follow"; toast("Slow down on follows — give it a minute."); }
        else { follow.disabled = false; follow.textContent = "+ Follow"; toast("Couldn't follow here — open the post and follow from X."); }
      })(); }); follow.disabled = followed.has(o.author);
      const dm = action("Plan DM", () => planDmFromReplySpot(o)); dm.title = "Save this public context in the draft-only DM workspace.";
      const replied = action("Mark replied", () => { expandedReplyCards.delete(o.id); opps.delete(o.id); recordSentReply("", o, undefined, Date.now(), "manual"); toast("Marked as replied — counted as manually verified."); }); replied.title = "Manual record only: counts this toward today's replies and removes it from the queue.";
      const skip = action("Skip", () => { expandedReplyCards.delete(o.id); opps.delete(o.id); renderDock(); }, true); skip.title = "Remove from the queue without counting a reply.";
      actions.append(openX, follow, dm, replied, skip); detail.append(actions); card.append(detail);
    }
    list.appendChild(card);
  }
}

/* ---------- Goobi's in-dock playground ---------- */

let dockPlayOpen = false;                          // the playground is expanded inside the dock
let goobiPlayHandle: GoobiHandle | null = null;    // the big, interactive Goobi in the playground
let goobiFed = 0, goobiPets = 0;                   // this session's care → earns a hunt
const fedEver = new Set<string>();                 // ids of replies Goobi has eaten (persisted) — fed treats don't come back
let fedTotal = 0;                                  // lifetime treats eaten (persisted), shown in the playground
const PLAY_HAPPY = 6;                              // a good few feeds to fully pump him up (pets barely move it)
function playHappiness(): number { return goobiFed + goobiPets * 0.1; } // feeding is what makes him happy; pets barely count
function goobiCelebrate(): void { goobiPlayHandle?.setMood("cheer"); goobiPlayHandle?.trick(); } // resting-happy + a random show-off move
function playReady(): boolean { return playHappiness() >= PLAY_HAPPY; }
function todaySent(): SentRecord[] { const dk = dayKey(Date.now()); return replyLog.sent.filter((r) => dayKey(r.at) === dk); }
function treatId(rec: SentRecord): string { return rec.id ?? String(rec.at); }
function persistFed(): void { safeSet({ [CONFIG.X_GOOBI_FED_KEY]: { ids: Array.from(fedEver).slice(-2000), total: fedTotal } }); }
const flyingTreats = new Set<HTMLElement>();        // in-flight treat clones, so we can clean them on close/teardown
function clearFlyingTreats(): void { flyingTreats.forEach((el) => { try { el.getAnimations?.().forEach((a) => a.cancel()); } catch { /* ignore */ } el.remove(); }); flyingTreats.clear(); }
/** Synchronous playground reset — every dock-dismissal path (✕, pause, relaunch, teardown) runs this
 *  so we never reopen into a stale playground or leak the big Goobi / in-flight treats. */
function resetPlay(): void { dockPlayOpen = false; goobiPlayHandle?.destroy(); goobiPlayHandle = null; clearFlyingTreats(); }

/** Sync the meter + hunt button to the live happiness (called after every feed/pet). */
function syncPlay(): void {
  if (!dockRoot) return;
  const pct = Math.min(100, Math.round((playHappiness() / PLAY_HAPPY) * 100));
  const ready = playReady();
  const fill = dockRoot.querySelector<HTMLElement>("#dpg-fill"); if (fill) fill.style.width = pct + "%";
  const en = dockRoot.querySelector("#dpg-energy"); if (en) en.textContent = ready ? "ready!" : pct + "%";
  const hunt = dockRoot.querySelector<HTMLButtonElement>("#dpg-hunt");
  if (hunt) {
    hunt.classList.toggle("ready", ready);
    hunt.disabled = !ready;
    hunt.textContent = ready ? "↻ Let's go hunt!" : "Cheer Goobi up first…";
    hunt.title = ready ? "Goobi's pumped — rescan the page for fresh reply spots" : "Feed or pet Goobi until he's happy, then he'll go find posts for you.";
  }
}

function petGoobi(): void {
  goobiPets++;
  if (playReady()) goobiCelebrate(); // pumped → a fresh random move every pet
  else { goobiPlayHandle?.setMood("cheer"); setTimeout(() => goobiPlayHandle?.setMood("idle"), 1200); }
  const msg = dockRoot?.querySelector("#dpg-msg");
  if (msg) { const happy = ["🎪 ta-da!", "🕺 he's dancing!", "✨ show-off!", "wheee!"]; const lines = ["hehe ♥", "boop!", "that tickles", "♥♥♥", "more!"]; msg.textContent = playReady() ? `${happy[Math.floor(Math.random() * happy.length)]} send him hunting ↻` : lines[Math.floor(Math.random() * lines.length)]; }
  syncPlay();
}

function feedTreat(b: HTMLButtonElement, rec: SentRecord, id: string, snip: string): void {
  if (fedEver.has(id)) return;
  fedEver.add(id); fedTotal++; persistFed(); // Goobi remembers what he's eaten — it won't come back
  const stage = dockRoot?.querySelector<HTMLElement>(".dpg-stage");
  const r = b.getBoundingClientRect();
  b.remove(); // pull it from the row now; the chomp + meter land when it arrives
  const arrive = () => {
    goobiFed++;
    goobiPlayHandle?.setMood("love"); // chomp
    setTimeout(() => { if (playReady()) goobiCelebrate(); else goobiPlayHandle?.setMood("idle"); }, 1400); // pumped → a random show-off move
    const msg = dockRoot?.querySelector("#dpg-msg");
    if (msg) msg.textContent = playReady() ? "🎪 Goobi's pumped — send him hunting! ↻" : `nom! "${snip.length > 32 ? snip.slice(0, 32) + "…" : snip}"`;
    const stat = dockRoot?.querySelector("#dpg-stat"); if (stat) stat.textContent = `🍪 ${fedTotal} ${fedTotal === 1 ? "treat" : "treats"} eaten`;
    syncPlay();
  };
  if (stage && typeof b.animate === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const sr = stage.getBoundingClientRect();
    const fly = document.createElement("div");
    fly.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-radius:50%;overflow:hidden;background:radial-gradient(circle at 35% 30%,#f0b07e,#c25e3f);box-shadow:0 1px 3px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none`;
    if (rec.avatar) { const fav = document.createElement("img"); fav.src = rec.avatar; fav.alt = ""; fav.referrerPolicy = "no-referrer"; fav.style.cssText = "width:100%;height:100%;object-fit:cover"; fav.onerror = () => fav.remove(); fly.append(fav); }
    document.documentElement.appendChild(fly); flyingTreats.add(fly);
    const dx = sr.left + sr.width / 2 - (r.left + r.width / 2);
    const dy = sr.top + sr.height * 0.6 - (r.top + r.height / 2);
    fly.animate([
      { transform: "translate(0,0) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.5}px,${dy * 0.5 - 30}px) scale(.85)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px,${dy}px) scale(.2)`, opacity: 0 },
    ], { duration: 440, easing: "cubic-bezier(.5,0,.6,1)" }).onfinish = () => { flyingTreats.delete(fly); fly.remove(); arrive(); };
  } else { arrive(); }
}

/** Build the playground panel (rendered at natural size; togglePlay handles the spring). */
function buildPlay(): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "dplay";
  const pg = document.createElement("div"); pg.className = "dpg";

  const stage = document.createElement("button"); stage.className = "dpg-stage"; stage.type = "button"; stage.title = "Tap to pet Goobi"; stage.setAttribute("aria-label", "Pet Goobi");
  stage.append(Object.assign(document.createElement("div"), { className: "dpg-shadow" }));
  stage.onclick = () => petGoobi();
  pg.append(stage);

  const unfed = todaySent().filter((rec) => !fedEver.has(treatId(rec))); // fed treats stay eaten (persisted)
  const msg = document.createElement("div"); msg.className = "dpg-msg"; msg.id = "dpg-msg";
  msg.textContent = unfed.length ? "Feed Goobi today's replies — or tap him to pet." : "All caught up — tap Goobi to pet him, then send him hunting.";
  pg.append(msg);

  const meter = document.createElement("div"); meter.className = "dpg-meter";
  meter.append(Object.assign(document.createElement("div"), { className: "dpg-fill", id: "dpg-fill" }));
  pg.append(meter);
  const lbl = document.createElement("div"); lbl.className = "dpg-lbl";
  lbl.append(Object.assign(document.createElement("span"), { textContent: "Goobi's energy" }), Object.assign(document.createElement("span"), { id: "dpg-energy" }));
  pg.append(lbl);
  const stat = document.createElement("div"); stat.className = "dpg-stat"; stat.id = "dpg-stat"; stat.textContent = `🍪 ${fedTotal} ${fedTotal === 1 ? "treat" : "treats"} eaten`;
  pg.append(stat);

  const treats = document.createElement("div"); treats.className = "dpg-treats"; treats.id = "dpg-treats";
  unfed.forEach((rec) => {
    const id = treatId(rec);
    const snip = rec.snippet || "a reply you sent";
    const b = document.createElement("button"); b.className = "dpg-treat"; b.title = (rec.author ? `@${rec.author} — ` : "") + snip;
    if (rec.avatar) { const av = document.createElement("img"); av.className = "dpg-av"; av.src = rec.avatar; av.alt = ""; av.referrerPolicy = "no-referrer"; av.onerror = () => av.remove(); b.append(av); } // the face of whoever you replied to
    b.onclick = () => feedTreat(b, rec, id, snip);
    treats.append(b);
  });
  pg.append(treats);

  const row = document.createElement("div"); row.className = "dpg-row";
  const back = document.createElement("button"); back.className = "dpg-back"; back.textContent = "‹ Posts"; back.title = "Back to your reply spots"; back.onclick = () => closePlay();
  const hunt = document.createElement("button"); hunt.className = "dpg-hunt"; hunt.id = "dpg-hunt"; hunt.onclick = () => { if (playReady()) closePlay(() => rescan()); };
  row.append(back, hunt);
  pg.append(row);

  // Preview every move — tap a chip and the big Goobi above does it.
  const mlbl = document.createElement("div"); mlbl.className = "dpg-movelbl"; mlbl.textContent = "Preview his moves";
  const moves = document.createElement("div"); moves.className = "dpg-moves";
  const MOVES: { label: string; mood?: GoobiMood; move?: string }[] = [
    { label: "Idle", mood: "idle" }, { label: "Search", mood: "searching" }, { label: "Think", mood: "thinking" },
    { label: "Happy", mood: "cheer" }, { label: "Love", mood: "love" }, { label: "Worn", mood: "worn" }, { label: "Sleep", mood: "sleeping" },
    { label: "Trick", move: "g-trick" }, { label: "Dance", move: "g-dance" }, { label: "Spin", move: "g-spin" }, { label: "Backflip", move: "g-flip" },
    { label: "Jump", move: "g-jump" }, { label: "Bounce", move: "g-bounce" }, { label: "Wiggle", move: "g-wiggle" }, { label: "Beat", move: "g-heartbeat" },
    { label: "Float", move: "g-float" }, { label: "Slide", move: "g-slide" }, { label: "Wave", move: "g-wave" },
  ];
  for (const m of MOVES) {
    const b = document.createElement("button"); b.className = "dpg-move"; b.textContent = m.label;
    b.onclick = () => { if (m.mood) goobiPlayHandle?.setMood(m.mood); else if (m.move) goobiPlayHandle?.play(m.move); };
    moves.append(b);
  }
  pg.append(mlbl, moves);

  wrap.append(pg);
  return wrap;
}

/** Framer-ish spring: panel height eases open, inner content overshoots in. */
function springOpen(panel: HTMLElement): void {
  if (typeof panel.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const inner = panel.firstElementChild as HTMLElement | null;
  const h = panel.scrollHeight;
  panel.animate([{ height: "0px" }, { height: h + "px" }], { duration: 380, easing: "cubic-bezier(.16,1,.3,1)" })
    .onfinish = () => { panel.style.height = ""; };
  inner?.animate([
    { opacity: 0, transform: "translateY(10px) scale(.98)" },
    { opacity: 1, transform: "translateY(0) scale(1)" },
  ], { duration: 460, easing: "cubic-bezier(.34,1.56,.64,1)" });
}
function springClose(panel: HTMLElement, done: () => void): void {
  if (typeof panel.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) { done(); return; }
  const h = panel.scrollHeight;
  panel.animate([{ height: h + "px", opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 260, easing: "cubic-bezier(.4,0,1,1)" }).onfinish = done;
}

function openPlay(): void {
  if (dockPlayOpen || paused) return;
  dockPlayOpen = true; goobiFed = 0; goobiPets = 0; // session energy resets; fedEver persists (he remembers what he ate)
  renderDock();
  const panel = dockRoot?.querySelector<HTMLElement>(".dplay");
  if (panel) springOpen(panel);
}
function closePlay(then?: () => void): void {
  const panel = dockRoot?.querySelector<HTMLElement>(".dplay");
  const finish = () => { resetPlay(); renderDock(); then?.(); };
  if (panel) springClose(panel, finish); else finish();
}
function togglePlay(): void { if (paused) return; dockPlayOpen ? closePlay() : openPlay(); }

/* ---------- post ideas (remix what's overperforming in your niche) ---------- */

const SHAPE_LABEL: Record<Shape, string> = { oneLiner: "one-liner", list: "list", numberLead: "number-led", contrarian: "contrarian", story: "story", question: "question", other: "mixed" };
/** The user's MEASURED best shape (settled own posts, one metric, min-N) — null when silent. */
function measuredShapeLine(): { line: string; n: number; metric: string } | null {
  const sp = shapePerformance(ownStats ?? [], Date.now());
  const top = sp?.shapes[0];
  if (!sp || !top || top.rel < 1.3) return null; // only speak when a shape clearly leads
  return { line: `their ${SHAPE_LABEL[top.shape]}-shaped posts earn ${top.rel.toFixed(1)}× their median ${sp.metric === "views" ? "views" : "engagement"} (n=${top.n}).`, n: top.n, metric: sp.metric };
}

/** Same honest shape read, but restricted to ideas Goobi matched exactly to real posts. This is the
 * action-grade signal for future idea generation; it falls back silently until enough posts settle. */
function measuredIdeaShapeLine(): { line: string; n: number; metric: string } | null {
  const posts = ideaQueue.flatMap((idea) => {
    const p = idea.publication;
    if (!p || p.confidence !== "exact") return [];
    return [{ text: idea.text, postedAt: p.postedAt ?? idea.postedAt, views: p.views, likes: p.likes, reposts: p.reposts }];
  });
  const sp = shapePerformance(posts, Date.now());
  const top = sp?.shapes[0];
  if (!sp || !top || top.rel < 1.3) return null;
  return { line: `their ${SHAPE_LABEL[top.shape]}-shaped Goobi drafts earn ${top.rel.toFixed(1)}× their median ${sp.metric === "views" ? "views" : "engagement"} (n=${top.n}, exact X matches).`, n: top.n, metric: sp.metric };
}

/** The best PATTERNS to remix: recent original niche posts that punch above their
 *  weight — follower-normalized engagement against a SIZE-TIERED expected rate (idea-quality.ts
 *  `expectedRate`: ~4% sub-1k … ~0.65% megas, floored at 8) so a small account's genuine breakout
 *  beats a mega-account's floor post AND an ordinary small-account post isn't mistaken for one.
 *  ≤2 per author so it's not one voice. (Tiers START from a published-benchmark prior; `calibrateRates`
 *  then tunes them to the user's niche from the posts each generation already fetched — free, no extra
 *  API call, sparse tiers keep the default.) */
type IdeaWinner = TwttrTweet & { shape: Shape };
/** Pick the over-performing posts the model is allowed to remix — the quality ceiling. Drops
 *  replies/RT-text/non-English/engagement-bait, keeps a recent window (21d → 60d fallback),
 *  scores genuine breakout (follower-normalized), floors low engagement, de-dupes near-identical
 *  sources, then enforces author + shape diversity. Returns rank-ordered (index 0 = strongest). */
function pickBest(tweets: TwttrTweet[], max: number): IdeaWinner[] {
  const now = Date.now();
  const base = tweets.filter((t) =>
    t.author && t.text && !t.isReply && t.text.length >= 40 &&
    !looksLikeRT(t.text) && isEnglish(t.text, t.lang) && !isBait(t.text));
  // Recency is a PREFERENCE, not a hard gate: prefer fresh, but on a quiet/evergreen niche fall
  // back to everything usable rather than fail (the empty-pool "broader niche" bug).
  const win = (days: number) => base.filter((t) => t.postedAt && now - t.postedAt < days * DAY_MS);
  let pool = win(21);
  if (pool.length < 6) pool = win(60);
  if (pool.length < 3) pool = base; // recency emptied it (old/undated niche) → remix what we have
  const medUnknown = percentile(pool.filter((t) => !t.followers).map((t) => (t.likes ?? 0) + (t.reposts ?? 0)).sort((a, b) => a - b), 0.5);
  let scored = pool.map((t) => { const s = scoreWinner(t, medUnknown); return { t, eng: s.eng, score: s.score, shape: classifyShape(t.text) }; });
  // Engagement floor is also a PREFERENCE: apply it only if enough clear it, else keep the ranked
  // pool (a quiet niche still gets ideas — better mediocre exemplars than a hard failure).
  const floor = Math.max(10, percentile(scored.map((s) => s.eng).sort((a, b) => a - b), 0.40));
  const floored = scored.filter((s) => s.eng >= floor);
  if (floored.length >= 3) scored = floored;
  const keptTok: Set<string>[] = [];
  scored = scored.filter((s) => { const tk = ideaTokens(s.t.text); if (keptTok.some((k) => jaccard(tk, k) >= INPUT_DEDUP)) return false; keptTok.push(tk); return true; }); // drop reposted/screenshotted dupes
  scored.sort((a, b) => b.score - a.score);
  const out: IdeaWinner[] = [];
  const perAuthor = new Map<string, number>(); const perShape = new Map<Shape, number>();
  const shapeCap = Math.ceil(max * 0.4); const enforceShape = scored.length >= 5;
  for (let rank = 0; rank < scored.length && out.length < max; rank++) {
    const s = scored[rank]; const ak = s.t.author.toLowerCase();
    if ((perAuthor.get(ak) ?? 0) >= 2) continue;                                   // ≤2 per author
    if (enforceShape && (perShape.get(s.shape) ?? 0) >= shapeCap) continue;        // ≤40% per shape (relaxed when thin)
    perAuthor.set(ak, (perAuthor.get(ak) ?? 0) + 1);
    perShape.set(s.shape, (perShape.get(s.shape) ?? 0) + 1);
    out.push({ ...s.t, shape: s.shape });
  }
  return out;
}

/** The user's own recent posts, pulled from the X-data API (from:<handle>) and cached.
 *  `posts` (text) powers idea de-dupe (24h TTL is fine); `stats` (real views/engagement)
 *  powers the momentum "views today" readout and wants fresher (60-min refresh on open).
 *  Best-effort everywhere: never throws, degrades to stale/empty if no handle / budget. */
const OWN_POSTS_TTL = 24 * HOUR_MS;     // idea de-dupe text
const OWN_STATS_TTL = 60 * 60_000;      // 60 min — real "views today" stat
interface OwnPostsCache { posts: string[]; stats?: OwnPost[]; at: number; handle: string }
let ownStats: OwnPost[] | undefined;    // in memory so the strip renders synchronously
async function myHandle(): Promise<string> { return (((await getLocal(CONFIG.X_MY_HANDLE_KEY)) as string) || "").replace(/^@/, "").trim(); }
/** One from:<handle> search-v3 call → cache both text (de-dupe) and stats (views). */
async function fetchOwnData(handle: string): Promise<OwnPostsCache | null> {
  const res = await send<{ ok?: boolean; data?: unknown; error?: string }>({
    type: "TWTTR_GET", path: "search-v3", query: { type: "Latest", count: "30", query: `from:${handle}` }, intent: true,
  });
  if (!res?.ok) return null; // budget/HTTP error — caller keeps stale
  const stats = pickOwnPostsWithStats(res.data, handle, 15);
  const cache: OwnPostsCache = { posts: stats.map((s) => s.text), stats, at: Date.now(), handle };
  safeSet({ [CONFIG.X_MY_POSTS_KEY]: cache });
  ownStats = stats;
  reconcileIdeasWithOwnPosts();
  captureGrowthData();
  return cache;
}
async function getOwnPosts(): Promise<{ text: string; likes?: number; reposts?: number }[]> {
  const handle = await myHandle();
  if (!handle) return [];
  const toLite = (c?: OwnPostsCache | null) =>
    c?.stats?.length ? c.stats.map((s) => ({ text: s.text, likes: s.likes, reposts: s.reposts })) : (c?.posts ?? []).map((t) => ({ text: t }));
  const cached = (await getLocal(CONFIG.X_MY_POSTS_KEY)) as OwnPostsCache | undefined;
  if (cached && cached.handle === handle && Date.now() - cached.at < OWN_POSTS_TTL) { ownStats = cached.stats ?? ownStats; return toLite(cached); }
  const fresh = await fetchOwnData(handle);
  return toLite(fresh ?? (cached?.handle === handle ? cached : undefined));
}
/** Refresh the real "views today" stat (60-min TTL). Fired on dock open; re-renders on change. */
async function refreshOwnStats(): Promise<void> {
  if (invalidated) return;
  const handle = await myHandle();
  if (!handle) { if (ownStats) { ownStats = undefined; renderDock(); } return; }
  const cached = (await getLocal(CONFIG.X_MY_POSTS_KEY)) as OwnPostsCache | undefined;
  if (cached && cached.handle === handle && Date.now() - cached.at < OWN_STATS_TTL) {
    ownStats = cached.stats;
    if (reconcileIdeasWithOwnPosts()) renderDock();
    captureGrowthData();
    return;
  }
  const before = ownStats;
  await fetchOwnData(handle);
  if (ownStats !== before) renderDock();
}
/** Real X-reported views + post count for TODAY (from the API stats), for the momentum strip. */
function ownViewsToday(): { posts: number; views: number; hasViews: boolean } {
  const today = dayKey(Date.now());
  const todays = (ownStats ?? []).filter((s) => s.postedAt && dayKey(s.postedAt) === today);
  const withViews = todays.filter((s) => typeof s.views === "number");
  return { posts: todays.length, views: withViews.reduce((a, s) => a + (s.views ?? 0), 0), hasViews: withViews.length > 0 };
}
/** Posts you shipped TODAY via the ideas tab — the momentum "posts" consistency signal. */
function postedToday(): number {
  const today = dayKey(Date.now());
  return ideaQueue.filter((i) => i.status === "posted" && i.postedAt && dayKey(i.postedAt) === today).length;
}

function dmPeopleToday(): number {
  const today = dayKey(Date.now());
  return new Set(dmStore.candidates.filter((c) => c.touches.some((t) => t.direction === "outbound" && dayKey(t.at) === today)).map((c) => c.handle)).size;
}

function dailyGoalTracker(counts: { replies: number; posts: number; dms: number }): HTMLElement {
  const wrap = document.createElement("section"); wrap.className = "day-goals"; wrap.setAttribute("aria-label", "Today's activity goals");
  const active = (Object.keys(dailyGoals) as Array<keyof DailyGoals>).filter((key) => dailyGoals[key] > 0);
  const complete = active.filter((key) => counts[key] >= dailyGoals[key]).length;
  const head = document.createElement("div"); head.className = "dg-head";
  const title = document.createElement("span"); title.className = "dg-title"; title.textContent = "Today";
  const summary = document.createElement("span"); summary.className = "dg-summary"; summary.textContent = active.length ? `${complete}/${active.length} goals complete` : "Goals are off";
  const edit = document.createElement("button"); edit.className = "dg-edit"; edit.textContent = "Edit goals"; edit.onclick = () => void send({ type: "OPEN_SIDE_PANEL" });
  head.append(title, summary, edit); wrap.append(head);
  const grid = document.createElement("div"); grid.className = "dg-grid";
  const specs: Array<{ key: keyof DailyGoals; label: string; view: DockView; title: string }> = [
    { key: "replies", label: "Replies", view: "replies", title: "Successful Like + insert attempts count immediately as pending; RapidAPI or manual confirmation later verifies them." },
    { key: "posts", label: "Posts", view: "ideas", title: "X-detected originals today, or posts explicitly marked shipped in Goobi when X data is unavailable." },
    { key: "dms", label: "DM people", view: "dms", title: "Unique people with an outbound DM you explicitly marked sent today. Goobi cannot read or verify the X inbox." },
  ];
  for (const spec of specs) {
    const target = dailyGoals[spec.key], done = counts[spec.key], met = target > 0 && done >= target;
    const item = document.createElement("button"); item.className = "dg-item" + (met ? " done" : ""); item.title = `${spec.title} Safety and quality limits always override volume goals.`;
    item.setAttribute("aria-label", `${spec.label}: ${target > 0 ? `${done} of ${target}` : "goal off"}`);
    item.onclick = () => { dockView = spec.view; relationshipsOpen = false; replyToolsOpen = false; renderDock(); };
    const top = document.createElement("span"); top.className = "dg-top";
    const label = document.createElement("span"); label.className = "dg-label"; label.textContent = spec.label;
    const count = document.createElement("span"); count.className = "dg-count"; count.textContent = target > 0 ? `${done}/${target}` : "Off";
    top.append(label, count);
    const track = document.createElement("span"); track.className = "dg-track"; const fill = document.createElement("span"); fill.className = "dg-fill"; fill.style.width = `${dailyGoalPercent(done, target)}%`; track.append(fill);
    item.append(top, track); grid.append(item);
  }
  wrap.append(grid); return wrap;
}

/* ---- Engagement learning loop ("who you show up with" + the Tier-2 measure-pass) ----
 * A once-a-day, dayKey-gated pass that (A) folds your own posts' real view-growth into a
 * bounded trend, and (B) fetches the real engagement your recent replies earned
 * (user-replies-v2), matches each back to a stored reply by text, and writes it into the
 * dormant SentRecord.outcome slot. Per-account aggregates are recomputed LIVE from the
 * reply log (idempotent) — only the own-post trend + scan gates persist. */
const LEARN_SCAN_ENABLED = true;   // the once-daily API fetch (Tier-1 ranking itself needs no fetch)
const SETTLE_DAYS = 2;             // freeze a reply's measured outcome once it's this old
const VERIFY_MIN_AGE_MS = 6 * 60_000;  // give X/provider timelines time to publish the reply before matching
const VERIFY_RETRY_MS = 30 * 60_000;   // a successful no-match waits; avoids hammering the expensive timeline endpoint
const VERIFY_WINDOW_MS = 72 * HOUR_MS; // same honest attribution window as matchOutcomes
interface DailySnap extends DailyDelta { day: string; followers?: number; } // followers = free daily snapshot (already in storage) → the measured "picking up" trend
interface LearnStore { handle: string; scanDay: string; measureDay?: string; measureAt?: number; restId?: string; prevById: Record<string, PostMetrics>; snaps: Record<string, DailySnap>; answeredThreadIds?: Record<string, number>; }
function freshLearn(handle: string): LearnStore { return { handle, scanDay: "", prevById: {}, snaps: {} }; }
let learn: LearnStore = freshLearn("");
let learnBusy = false;
let verifyTimer: ReturnType<typeof setTimeout> | undefined;

/** A text-bearing record gets an early API proof pass even when the user manually confirmed it.
 * Proven provisional outcomes become due once more at settlement age. This closes the old gap
 * where Fresh Reach's manual handoff waited until the daily pass and could roll out of the recent
 * reply window before it ever acquired its reply tweet id. */
function pendingVerification(now: number): SentRecord | undefined {
  return [...replyLog.sent].reverse().find((r) => {
    const age = now - r.at;
    if (!(r.norm || r.snippet) || age < VERIFY_MIN_AGE_MS || age > VERIFY_WINDOW_MS || r.outcome?.frozen) return false;
    return !r.outcome?.tweetId || age >= SETTLE_DAYS * 24 * HOUR_MS;
  });
}
function verificationDue(now: number): boolean {
  const pending = pendingVerification(now);
  if (!pending) return false;
  const retry = pending.outcome?.tweetId ? 12 * HOUR_MS : VERIFY_RETRY_MS;
  return !learn.measureAt || learn.measureAt < pending.at || now - learn.measureAt >= retry;
}
function scheduleReplyVerification(): void {
  if (verifyTimer != null) return;
  verifyTimer = setTimeout(() => {
    verifyTimer = undefined;
    if (!invalidated && !paused) void maybeRunDailyLearn();
  }, VERIFY_MIN_AGE_MS + 30_000);
}
function pruneSnaps(snaps: Record<string, DailySnap>): void {
  const cut = dayKey(Date.now() - 60 * 24 * HOUR_MS);
  for (const k of Object.keys(snaps)) if (k < cut) delete snaps[k];
}
/** Own-posts' real view-growth this week (X-reported), summed over the daily snaps. */
function weeklyViewGrowth(): { views: number; days: number } {
  const cut = dayKey(Date.now() - 7 * 24 * HOUR_MS);
  let views = 0, days = 0;
  for (const [k, s] of Object.entries(learn.snaps)) if (k >= cut) { views += s.views; days++; }
  return { views, days };
}
/** Fetch your recent replies' real engagement, match each to a stored reply, and write the
 *  outcome (likes/replies). Provisional until SETTLE_DAYS old, then frozen. Best-effort. */
async function runMeasurePass(handle: string, today: string): Promise<void> {
  if (!replyLog.sent.length && !inbound.length) { learn.measureDay = today; learn.measureAt = Date.now(); return; }
  let restId = learn.restId;
  if (!restId) {
    const ures = await send<{ ok?: boolean; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "user", query: { username: handle }, intent: true });
    if (ures?.error === "no-twttr-config") { twttrUnconfigured = true; return; } // no key → stop trying until settings change
    const u = ures?.ok ? parseUser(ures.data) : null;
    if (!u?.id) return; // couldn't resolve rest_id — retry next day, don't burn the gate
    restId = u.id;
  }
  const rres = await send<{ ok?: boolean; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "user-replies-v2", query: { user: restId, count: "80" }, intent: true });
  if (rres?.error === "no-twttr-config") { twttrUnconfigured = true; return; }
  if (!rres?.ok) return; // budget/HTTP error — retry next day
  const now = Date.now();
  const parsed = parseTimelineTweets(rres.data);
  const ownReplies = parsed.filter((t) => t.isReply && t.text && (t.authorId ? t.authorId === restId : t.author.toLowerCase() === handle.toLowerCase()));
  learn.answeredThreadIds ??= {};
  for (const t of ownReplies) if (t.replyToId) learn.answeredThreadIds[t.replyToId] = t.postedAt ?? now; // exact parent join: this inbound status was actually answered
  pruneAnsweredThreadIds(now);
  foldRelationshipMemory(); // preserve exact completed exchanges beyond the short thread-clearing window
  const fetched: FetchedReply[] = ownReplies
    .map((t) => ({ text: t.text, at: t.postedAt, likes: t.likes, replies: t.replies, views: t.views, reposts: t.reposts, id: t.id })); // views/reposts/id ride the same paid response — views = distribution (the thing the ranker actually decides), id enables future ground-truth fetches
  let wrote = 0;
  for (const mt of matchOutcomes(fetched, replyLog.sent)) {
    const rec = replyLog.sent[mt.index];
    if (!rec || rec.outcome?.frozen) continue; // frozen = settled, never re-touch
    rec.outcome = mergeReplyOutcomes(rec.outcome, {
      at: now,
      likes: mt.likes,
      replies: mt.replies,
      views: mt.views,
      reposts: mt.reposts,
      tweetId: mt.replyId,
      frozen: now - rec.at >= SETTLE_DAYS * 24 * HOUR_MS,
    });
    rec.confirmedAt ??= now;
    rec.confirmation = "rapidapi";
    wrote++;
  }
  if (fetched.length) learn.restId = restId; // cache the resolved id ONLY when it proved it works (returned replies) — a bad/transient resolve re-resolves next day instead of freezing
  learn.measureDay = today;
  learn.measureAt = now;
  if (wrote) {
    invalidateLearnedMults();
    syncFreshReachShortlistIntoRadar();
    safeSet({ [CONFIG.X_REPLY_LOG_KEY]: replyLog });
  }
  safeSet({ [CONFIG.X_LEARN_STATS_KEY]: learn });
}
/** The once-daily learning pass, dayKey-gated + idempotent. Fired on dock open. */
async function maybeRunDailyLearn(): Promise<void> {
  if (invalidated || paused || learnBusy || !LEARN_SCAN_ENABLED || twttrUnconfigured) return;
  const handle = await myHandle();
  if (!handle) return;
  if (learn.handle !== handle) learn = freshLearn(handle); // handle switch → reset the trend
  const today = dayKey(Date.now());
  // The engaged-back join runs on EVERY dock open (pure, idempotent, $0) — new notification
  // events since the morning pass still credit same-day; the day-gate below only guards fetches.
  if (fillAuthorReplied(inbound, replyLog.sent) > 0) safeSet({ [CONFIG.X_REPLY_LOG_KEY]: replyLog });
  const verifyDue = verificationDue(Date.now());
  if (learn.scanDay === today && learn.measureDay === today && !verifyDue) return; // daily passes done; pending new replies may still request one verification
  learnBusy = true;
  try {
    // (A) own-post view-growth trend — CONSUME the momentum cache only. refreshOwnStats (fired
    // first on dock-open) owns the from:<handle> fetch, so the two paths can't double-bill it;
    // no fresh cache yet → skip the fold this open, pick it up next time.
    if (learn.scanDay !== today) {
      let stats: OwnPost[] | undefined;
      const cached = (await getLocal(CONFIG.X_MY_POSTS_KEY)) as OwnPostsCache | undefined;
      if (cached?.handle === handle && Date.now() - cached.at < OWN_STATS_TTL) stats = cached.stats;
      const fresh = (await getLocal(CONFIG.X_LEARN_STATS_KEY)) as LearnStore | undefined; // multi-tab race: re-read after await
      if (fresh && fresh.handle === handle) learn = fresh;
      const day2 = dayKey(Date.now());
      if (stats && learn.scanDay !== day2) {
        const { delta, nextPrev } = foldOwnDelta(learn.prevById, stats);
        learn.snaps[day2] = { day: day2, ...delta, followers: myFollowers || undefined }; // free follower snapshot → measured trend
        learn.prevById = nextPrev;
        learn.scanDay = day2;
        pruneSnaps(learn.snaps);
        safeSet({ [CONFIG.X_LEARN_STATS_KEY]: learn });
        captureGrowthData();
      }
    }
    // (B) Tier-2 measure-pass — the real engagement your replies earned.
    if (learn.measureDay !== today || verifyDue) await runMeasurePass(handle, today);
  } finally { learnBusy = false; renderDock(); }
}

/* ---- Reciprocity engine: who engages with ME (harvested from the notifications page) ----
 * Zero API: the content script already runs on x.com. On /notifications the reply tweets
 * render as full articles; on /notifications/mentions the mentions do. Both carry a clean
 * status id, so we capture reply/mention engagement reliably. (Likes/reposts are lossy +
 * locale-fragile — deferred; we don't guess them.) Device-local; never leaves the browser. */
let inbound: EngagedRecord[] = [];
let inboundKeys = new Set<string>();
const SUPPORTERS_MAX = 1000;
let relationshipMemory: RelationshipMemoryStore = freshRelationshipMemory();
let relationshipPersist: Promise<void> = Promise.resolve();
/** Fold either-arrival-order proof (notifications or reply history), then union with storage so
 * concurrent X tabs cannot erase exchanges. Exact parent IDs make this idempotent. */
function foldRelationshipMemory(): void {
  const owner = (learn.handle || selfHandle || "").toLowerCase();
  const folded = foldCompletedExchanges(relationshipMemory, owner, inbound, learn.answeredThreadIds, Date.now());
  relationshipMemory = folded.store;
  if (!folded.changed) return;
  relationshipPersist = relationshipPersist.then(async () => {
    const stored = await getLocal(CONFIG.X_RELATIONSHIP_MEMORY_KEY) as RelationshipMemoryStore | undefined;
    relationshipMemory = mergeRelationshipMemory(stored, relationshipMemory, Date.now());
    safeSet({ [CONFIG.X_RELATIONSHIP_MEMORY_KEY]: relationshipMemory });
  }).catch(() => {});
}
// Reply postIds the user has explicitly MARKED DONE in "tend your threads" (device-local). Pruned to
// the live harvest on persist so it can't grow unbounded as old events age out of the window.
let threadsDone = new Set<string>();
function hydrateThreadsDone(arr: unknown): void { if (Array.isArray(arr)) threadsDone = new Set(arr.filter((x): x is string => typeof x === "string")); }
const ANSWERED_THREAD_KEEP_MS = TEND_WINDOW_MS + 2 * 24 * HOUR_MS; // provider's recent-40 window may roll before the 3d tend queue does
const ANSWERED_THREAD_CAP = 500;
function pruneAnsweredThreadIds(now: number): void {
  const entries = Object.entries(learn.answeredThreadIds ?? {})
    .filter(([id, at]) => !!id && typeof at === "number" && now - at <= ANSWERED_THREAD_KEEP_MS && now >= at)
    .sort((a, b) => b[1] - a[1])
    .slice(0, ANSWERED_THREAD_CAP);
  learn.answeredThreadIds = Object.fromEntries(entries);
}
/** Manual done + exact parent IDs from RapidAPI. Exact matches disappear; unmatched rows keep
 * the existing soft handle/time "likely tended" inference. */
function completedThreadIds(): Set<string> { return new Set([...threadsDone, ...Object.keys(learn.answeredThreadIds ?? {})]); }
function persistThreadsDone(): void {
  const live = new Set(inbound.map((e) => e.postId).filter((x): x is string => !!x));
  threadsDone = new Set([...threadsDone].filter((id) => live.has(id))); // drop keys whose event has aged out of the harvest
  safeSet({ [CONFIG.X_THREADS_DONE_KEY]: [...threadsDone] });
}
/** Adopt an inbound array from storage (boot OR cross-tab sync) — validate shape, drop >60d,
 *  cap, and rebuild the key index. Never trust foreign/partial writes raw. */
function hydrateInbound(arr: unknown): void {
  if (!Array.isArray(arr)) return;
  const cut = Date.now() - 60 * 24 * HOUR_MS;
  let recs = (arr as EngagedRecord[]).filter((e) => e && e.handle && e.key && e.kind && e.at >= cut);
  if (recs.length > SUPPORTERS_MAX) recs = recs.slice(-SUPPORTERS_MAX);
  inbound = recs; inboundKeys = new Set(recs.map((e) => e.key));
}
function pushInbound(rec: EngagedRecord): void {
  inbound.push(rec); inboundKeys.add(rec.key);
  if (inbound.length > SUPPORTERS_MAX) { const drop = inbound.splice(0, inbound.length - SUPPORTERS_MAX); for (const d of drop) inboundKeys.delete(d.key); }
}
function persistInbound(): void {
  const cut = Date.now() - 60 * 24 * HOUR_MS; // keep ~60 days
  if (inbound.some((e) => e.at < cut)) { inbound = inbound.filter((e) => e.at >= cut); inboundKeys = new Set(inbound.map((e) => e.key)); }
  safeSet({ [CONFIG.X_SUPPORTERS_KEY]: inbound });
}
let persistInboundTimer: number | undefined;
function schedulePersistInbound(): void {
  if (persistInboundTimer) clearTimeout(persistInboundTimer);
  persistInboundTimer = setTimeout(() => { persistInboundTimer = undefined; persistInbound(); }, 1500) as unknown as number; // coalesce writes while scrolling notifications
}
/** Harvest reply/mention engagement from the notifications-route articles. Idempotent
 *  (dedup by `${kind}:${statusId}`); skips self; never queues these for reply-scoring. */
function scanNotifications(): void {
  if (invalidated) return;
  if (!selfHandle) selfHandle = getSelf();
  const self = selfHandle;
  const kind: EngagedKind = location.pathname.startsWith("/notifications/mentions") ? "mention" : "reply";
  let added = 0;
  document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]').forEach((el) => {
    const info = statusInfo(el);
    if (!info) return;
    if (self && info.author.toLowerCase() === self) return; // not my own posts
    const key = info.id; // dedup on the globally-unique status id — a reply that also @-mentions you renders on BOTH tabs; count it once
    if (inboundKeys.has(key)) return;
    pushInbound({ at: postedAtMs(el) ?? Date.now(), handle: info.author, kind, postId: info.id, avatar: avatarUrl(el), name: displayName(el), text: outerText(el).slice(0, 240) || undefined, key, followers: authorReach.get(info.author.toLowerCase())?.followers }); // follower backfill from the reach cache — activates supporters' reachBoost (else it sits at the FALLBACK constant); text snippet powers "tend your threads"
    added++;
  });
  if (added) { foldRelationshipMemory(); schedulePersistInbound(); if (dockOpen) renderDock(); } // either arrival order works; debounced write; only repaint when the dock is open
}

/** The most recent avatar/display we've seen for a handle (for the insight rows). */
function lastSeenFor(handle: string): string | undefined {
  const h = handle.toLowerCase();
  for (let i = replyLog.sent.length - 1; i >= 0; i--) { const s = replyLog.sent[i]; if (s.author?.toLowerCase() === h && s.avatar) return s.avatar; }
  return undefined;
}
function letterChip(handle: string): HTMLElement {
  const c = document.createElement("div"); c.className = "ins-av ins-av-l"; c.textContent = (handle[0] || "?").toUpperCase(); return c;
}
function avatarChip(handle: string, url?: string): HTMLElement {
  if (!url) return letterChip(handle);
  const img = document.createElement("img"); img.className = "ins-av"; img.src = url; img.referrerPolicy = "no-referrer";
  img.onerror = () => img.replaceWith(letterChip(handle)); // expired pbs.twimg.com URL → degrade to the letter
  return img;
}
/** "Who you show up with" — a collapsed dock section ranking the accounts you engage with by
 *  reply INVESTMENT (always), upgraded with REAL measured engagement (✓) as outcomes settle.
 *  Honest by construction: shrunk small samples, gated thin rows, no causation/reach claims. */
/** "Tend your threads" — the highest-value surface Goobi didn't cover: the people who replied to /
 *  mentioned you (from the notifications harvest, $0), ranked freshest-first into a to-tend queue.
 *  Answering a reply on your own thread is the top-ordered growth action (author-engaged replies
 *  grade highest; keeping a conversation alive is what dedup_conversation_filter promotes). Honest:
 *  we can't see which of your posts each is on, "tended" is a lossy guess, opens the thread so you
 *  reply in your own words. It's an ACTION list, so it hides itself when there's nothing to tend. */
function renderThreadsPanel(d: HTMLElement, opts: { topLevel?: boolean } = {}): void {
  const now = Date.now();
  const { rows, total } = rankThreads(inbound as InboundLite[], replyLog.sent, now, opts.topLevel ? 20 : 8, completedThreadIds());
  if (total === 0) return; // nothing recent to tend → the tab is hidden anyway
  const wrap = document.createElement("div"); wrap.className = "insight rel-body";
  {
    const body = document.createElement("div"); body.className = "ins-body";
    const shown = opts.topLevel ? rows : threadsAll ? rows : rows.slice(0, 3); // top-level owns the workspace; the old embedded panel stayed compact
    for (const r of shown) {
      const row = document.createElement("div"); row.className = "ins-row";
      const av = avatarChip(r.handle, r.avatar); av.style.cursor = "pointer"; av.title = `Open @${r.handle}`;
      av.onclick = () => window.open(`https://x.com/${r.handle}`, "_blank", "noopener");
      row.append(av);
      const mid = document.createElement("div"); mid.className = "ins-mid";
      const top = document.createElement("div"); top.className = "ins-top";
      const h = document.createElement("span"); h.className = "ins-h"; h.textContent = "@" + r.handle; top.append(h);
      // Freshness rides ON the age label (green = live) — a separate "● live" badge per row was
      // pure noise once every row in a fresh harvest qualified.
      const age = document.createElement("span"); age.className = "ins-ar"; age.textContent = r.ageLabel;
      if (r.fresh === "live") { age.style.color = "#6fcf7f"; age.title = "still in the thread's live window — answering now compounds most"; }
      top.append(age);
      const relationship = document.createElement("span"); relationship.className = "ins-thin";
      relationship.textContent = r.kind === "reply" ? "↩ Replied to your post" : "@ Mentioned you";
      relationship.style.color = r.kind === "reply" ? "#8bd397" : "#d6b07c";
      relationship.title = r.kind === "reply"
        ? "This person replied directly to one of your posts. Goobi ranks it as warm inbound conversation."
        : "This person mentioned you, but this is not confirmed as a comment on one of your posts.";
      top.append(relationship);
      if (r.tended) { const b = document.createElement("span"); b.className = "ins-thin"; b.textContent = "likely tended"; b.title = "You sent a Goobi reply to them after they engaged you — a lossy handle+time guess (could be a different post), not a confirmed answer."; top.append(b); }
      mid.append(top);
      if (r.text) {
        const meta = document.createElement("div"); meta.className = "ins-meta";
        meta.textContent = `"${r.text.length > 80 ? r.text.slice(0, 80) + "…" : r.text}"`;
        meta.title = "Their reply/mention, captured from your notifications (stays on your device).";
        mid.append(meta);
      }
      row.append(mid);
      const acts = document.createElement("div"); acts.style.cssText = "flex:none;align-self:center;display:flex;gap:5px;align-items:center";
      const doneBtn = document.createElement("button");
      doneBtn.textContent = "✓"; doneBtn.setAttribute("aria-label", `Mark @${r.handle}'s thread done`);
      doneBtn.title = "Mark done — clears it from your tend queue (stays on your device; the reciprocity panel still counts them).";
      doneBtn.style.cssText = "font:600 12px -apple-system,system-ui,sans-serif;color:#8c7d68;background:none;border:1px solid rgba(214,154,92,.25);border-radius:6px;padding:3px 8px;cursor:pointer";
      doneBtn.disabled = !r.postId;
      doneBtn.onclick = () => { if (r.postId) { threadsDone.add(r.postId); persistThreadsDone(); toast(`Marked @${r.handle} done.`); renderDock(); } };
      const act = document.createElement("button");
      act.textContent = r.kind === "reply" ? "Reply back →" : "Reply →"; act.setAttribute("aria-label", `Open @${r.handle}'s reply to respond`);
      act.title = "Open their reply on X so you can respond in-thread (Goobi never posts for you).";
      act.style.cssText = "font:600 11px -apple-system,system-ui,sans-serif;color:#e89a3c;background:rgba(232,154,60,.12);border:1px solid rgba(232,154,60,.35);border-radius:6px;padding:3px 8px;cursor:pointer";
      act.onclick = () => { if (r.postId) window.open(`https://x.com/${r.handle}/status/${r.postId}`, "_blank", "noopener"); };
      acts.append(doneBtn, act);
      row.append(acts);
      body.append(row);
    }
    if (!opts.topLevel && rows.length > 3) {
      const more = document.createElement("div"); more.className = "ins-more";
      more.style.cursor = "pointer";
      more.setAttribute("role", "button"); more.tabIndex = 0;
      more.textContent = threadsAll ? "▴ show fewer" : `▾ ${rows.length - 3} more`;
      const toggleAll = () => { threadsAll = !threadsAll; renderDock(); };
      more.onclick = toggleAll;
      more.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleAll(); } };
      body.append(more);
    }
    // One terse line; the full honesty text stays a hover away (same disclosures, less real estate).
    const foot = document.createElement("div"); foot.className = "ins-foot";
    foot.textContent = `${opts.topLevel ? `Showing the freshest ${rows.length}${total > rows.length ? ` of ${total}` : ""} · ` : "Freshest first · "}exact reply-history matches clear automatically · \"likely tended\" is still a guess.`;
    foot.title = "An exact match means one of your recent RapidAPI replies reports this notification status as its direct parent, so it clears automatically. The provider returns a recent window, so unmatched does not mean unanswered; those rows keep the softer handle+time \"likely tended\" guess. Opens the thread on X so you reply in your own words; Goobi never posts for you.";
    body.append(foot);
    wrap.append(body);
  }
  d.append(wrap);
}

function buildComments(): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "comments";
  const intro = document.createElement("section"); intro.className = "comments-intro";
  const title = document.createElement("div"); title.className = "comments-title"; title.textContent = "Warm conversations first";
  const copy = document.createElement("div"); copy.className = "comments-copy";
  copy.textContent = "Comments on your own posts get the strongest warm signal. Goobi labels those separately from mentions because continuing inbound conversation is more important than cold outreach.";
  intro.append(title, copy); wrap.append(intro);
  const ranked = rankThreads(inbound as InboundLite[], replyLog.sent, Date.now(), 20, completedThreadIds());
  if (ranked.total) renderThreadsPanel(wrap, { topLevel: true });
  else {
    const empty = document.createElement("div"); empty.className = "comments-empty";
    const message = document.createElement("div"); message.textContent = "No recent reply or mention is waiting. Goobi learns this queue from the X notifications page you visit; it never reads your private inbox.";
    const scan = document.createElement("button"); scan.className = "gx-btn"; scan.textContent = "Open X notifications ↗";
    scan.onclick = () => window.open("https://x.com/notifications", "_blank", "noopener");
    empty.append(message, scan); wrap.append(empty);
  }
  return wrap;
}

function renderInsightPanel(d: HTMLElement): void {
  const now = Date.now();
  const agg = aggregateAccounts(replyLog.sent, now);
  const { ranked, learning } = rankAccounts(agg);
  const wrap = document.createElement("div"); wrap.className = "insight rel-body";
  {
    const body = document.createElement("div"); body.className = "ins-body";
    // The OUTCOME half of momentum: is the account actually picking up? Measured per-post results,
    // week over week, from the daily snaps — silent until both windows have real posts (no guessing).
    const at = accountTrend(learn.snaps, now);
    if (at) {
      const t = document.createElement("div"); t.className = "ins-trend";
      t.style.color = at.state === "picking-up" ? "#6fcf7f" : at.state === "cooling" ? "#d6604a" : "#8c7d68"; // color = state; a cooling trend must never render in positive green
      const icon = at.state === "picking-up" ? "\u{1F4C8} " : at.state === "cooling" ? "\u{1F4C9} " : "\u2192 ";
      const label = at.state === "picking-up" ? "Picking up" : at.state === "cooling" ? "Cooling" : "Steady";
      const unit = at.metric === "views" ? "views" : "eng";
      const fd = at.followerDelta;
      t.textContent = `${icon}${label}: ~${fmtCount(Math.round(at.nowPer))} ${unit}/post this week vs ${fmtCount(Math.round(at.prevPer))} last week`
        + (fd != null && fd !== 0 ? ` \u00B7 ${fd > 0 ? "+" : ""}${fd} followers` : "");
      t.title = `Measured from ${at.metric === "views" ? "X-reported views" : "likes+reposts+replies"} on your own posts: ${at.nowPosts} post${at.nowPosts === 1 ? "" : "s"} this week vs ${at.prevPosts} last. Consistency compounds through repeat engagement (affinity + reputation) \u2014 X has no literal streak bonus, so this tracks RESULTS, not activity.`;
      body.append(t);
    }
    // The 14d funnel — measured totals that CO-OCCURRED, never attribution (profile clicks are
    // invisible to us; follows can come from anywhere). The arc is the growth mechanism the
    // 2026 pipeline scores (reply → profile visit → follow-author); the numbers are real.
    {
      const cutMs = now - 14 * 24 * HOUR_MS;
      const cutF = dayKey(cutMs);
      const verified = replyVerificationSummary(replyLog.sent, cutMs, now);
      const sent14 = verified.confirmed;
      if (sent14 > 0) {
        const people = new Set(inbound.filter((e) => e.at >= cutMs).map((e) => e.handle.toLowerCase())).size;
        let fDelta: number | undefined;
        const withF = Object.values(learn.snaps).filter((sn) => sn.followers != null && sn.day >= cutF).sort((a, b) => (a.day < b.day ? -1 : 1));
        if (withF.length >= 2 && withF[0].day !== withF[withF.length - 1].day) fDelta = (withF[withF.length - 1].followers as number) - (withF[0].followers as number);
        const t2 = document.createElement("div"); t2.className = "ins-fact";
        t2.textContent = `🔀 14d: ${sent14} verified ${sent14 === 1 ? "reply" : "replies"} → ${people} ${people === 1 ? "person" : "people"} engaged with you` + (fDelta != null ? ` → ${fDelta >= 0 ? "+" : ""}${fDelta} followers` : ""); // "engaged with you" (all inbound), deliberately NOT the join's stricter "engaged back"
        t2.title = `Replies are actual X posts matched through RapidAPI or manually confirmed; ${verified.pending} recent attempt${verified.pending === 1 ? " is" : "s are"} still pending and excluded. The other totals co-occurred over 14 days — correlation, NOT attribution: profile clicks aren't visible and follows can come from anywhere.`;
        body.append(t2);
      }
    }
    // WHAT works for you (the feature learner): measured per-angle + the timing lever, min-N gated —
    // below the gate a line simply doesn't render. Soft consumption only (the \u2605 on the angle chips).
    {
      const fl = learnFeatures(replyLog.sent, now);
      const bits: Array<[string, string]> = [];
      for (const a of fl.angles.slice(0, 2)) {
        if (a.rel >= 1.15 || a.rel <= 0.85) bits.push([`${a.rel >= 1.15 ? "\u25B2" : "\u25BC"} ${catLabel(a.angle)} replies: ${a.rel.toFixed(1)}\u00D7 your avg (n=${a.n})`, "Reach-normalized engagement on your own measured replies, shrunk toward your mean. Correlation, not causation."]);
      }
      if (fl.ageGradient != null && (fl.ageGradient >= 1.5 || fl.ageGradient <= 0.67)) {
        bits.push([`\u23F1 Replies to <15m-old posts earn ~${fl.ageGradient.toFixed(1)}\u00D7 your 1h+ ones (n=${fl.freshN} vs ${fl.staleN})`, "The timing lever measured on YOUR replies \u2014 the same early-window mechanism the ranker rewards."]);
      }
      for (const [txt, why] of bits) {
        const li = document.createElement("div"); li.className = "ins-fact"; li.textContent = txt;
        li.title = why + (fl.fitCorr != null ? ` (baseline priority\u2194outcome \u03C1=${fl.fitCorr.toFixed(2)}, n=${fl.nOut})` : "");
        body.append(li);
      }
    }
    // Profile check — the conversion surface (replies earn the click; the PROFILE converts it to a
    // follow). Measured facts only: pinned-vs-your-best + bio presence. Silent without a harvest —
    // it fills in the first time the user visits their own profile with Goobi on.
    for (const f of profileCheck(profileStateForCurrentOwner(), ownStats ?? []).slice(0, 3)) {
      const li = document.createElement("div"); li.className = f.level === "good" ? "ins-trend" : "ins-fact"; // green only for the ✓
      li.textContent = (f.level === "act" ? "\u2192 " : "\u2713 ") + f.text;
      li.title = f.why;
      body.append(li);
    }
    const wk = weeklyViewGrowth();
    if (wk.views > 0) { const t = document.createElement("div"); t.className = "ins-trend"; t.textContent = `Your posts: +${fmtCount(wk.views)} views ${wk.days >= 7 ? "this week" : `last ${wk.days}d`}`; t.title = "X-reported view growth on your own posts, summed from the daily scan."; body.append(t); }

    if (agg.attributed < GLOBAL_THIN) {
      const s = document.createElement("div"); s.className = "ins-learn";
      s.textContent = `Still learning — ${agg.attributed}/${GLOBAL_THIN} replies logged. I'll map who you show up with around a dozen.`;
      body.append(s);
    } else {
      const arrow = (t: ReturnType<typeof cadenceTrend>) => (t === "up" ? "↑" : t === "down" ? "↓" : t === "flat" ? "→" : "");
      const truncated = replyLog.sent.length >= SENT_MAX;
      for (const r of ranked) {
        const row = document.createElement("div"); row.className = "ins-row";
        row.append(avatarChip(r.handle, lastSeenFor(r.handle)));
        const mid = document.createElement("div"); mid.className = "ins-mid";
        const top = document.createElement("div"); top.className = "ins-top";
        const h = document.createElement("span"); h.className = "ins-h"; h.textContent = "@" + r.handle;
        top.append(h);
        const tr = arrow(cadenceTrend(replyLog.sent, r.handle, now, truncated));
        if (tr) { const a = document.createElement("span"); a.className = "ins-ar"; a.textContent = tr; a.title = "your reply cadence with them — not their response"; top.append(a); }
        if (r.tier === "measured") { const b = document.createElement("span"); b.className = "ins-badge"; const rel = r.score! > agg.muObs * 1.1 ? "▲ above your avg" : r.score! < agg.muObs * 0.9 ? "▼ below" : "~ typical"; b.textContent = "✓ " + rel; b.title = "Backed by the real likes/replies your replies to them earned (reach-normalized)."; top.append(b); }
        else if (r.thin) { const b = document.createElement("span"); b.className = "ins-thin"; b.textContent = "thin"; top.append(b); }
        mid.append(top);
        const meta = document.createElement("div"); meta.className = "ins-meta";
        const days = Math.max(0, Math.round((now - r.lastAt) / (24 * HOUR_MS)));
        meta.textContent = `${r.replies} ${r.replies === 1 ? "reply" : "replies"} · last ${days}d` + (r.backs ? ` · ↩ engaged back ×${r.backs}` : "") + (r.followers ? ` · ${fmtCount(r.followers)} followers` : "");
        meta.title = "Reply attempts recorded through Goobi" + (r.backs ? `; "engaged back" = they replied to you within 72h of your reply (matched from your notifications — visit-dependent, may undercount, and can include replies to your own posts).` : "") + (r.followers ? "; their follower count when you replied — not a reach estimate." : ".");
        mid.append(meta);
        const bar = document.createElement("div"); bar.className = "ins-bar"; const fill = document.createElement("div"); fill.className = "ins-fill"; fill.style.width = Math.round(r.share * 100) + "%"; bar.append(fill); mid.append(bar);
        row.append(mid);
        const pips = document.createElement("div"); pips.className = "ins-pips"; pips.textContent = "●".repeat(r.confidence) + "○".repeat(3 - r.confidence); pips.title = "how much you've done with them — not a prediction"; row.append(pips);
        body.append(row);
      }
      const conc = concentration(replyLog.sent);
      if (conc) { const n = document.createElement("div"); n.className = "ins-nudge"; n.textContent = `You've sent ${Math.round(conc.pct * 100)}% of recent replies to @${conc.handle}. Mixing in other accounts keeps you from reading as a single-target bot.`; body.append(n); }
      if (learning.length) { const more = document.createElement("div"); more.className = "ins-more"; more.textContent = `+${learning.length} still learning`; body.append(more); }
      const foot = document.createElement("div"); foot.className = "ins-foot";
      foot.textContent = "Ranked by where you invest your replies; ✓ means it's backed by the real likes/replies those replies earned. Replying to someone doesn't make them engage back — this mirrors your effort and its measured payoff.";
      body.append(foot);
    }
    wrap.append(body);
  }
  d.append(wrap);
}

function relBadge(rel: Rel): { text: string; cls: string } | null {
  if (rel === "mutual") return { text: "↔ mutual", cls: "ins-rel-mut" };
  if (rel === "fan") return { text: "shows up for you", cls: "ins-rel-fan" };
  return null; // one-way-you / acquaintance — no badge on the supporters list
}
/** "Who shows up for you" — accounts that reply to / mention you (from your notifications),
 *  with a mutual/fan label (fused with "who you show up with") + an anti-pod ring guard.
 *  Honest by construction: a sample not a ledger, draft-only (tap to their profile), no
 *  like-for-like nudging. */
function renderSupportersPanel(d: HTMLElement): void {
  const now = Date.now();
  const wrap = document.createElement("div"); wrap.className = "insight rel-body";
  {
    const sup = aggregateSupporters(inbound, now);
    const { ranked, learning, totalScored } = rankSupporters(sup);
    const rel = fuseMutual(aggregateAccounts(replyLog.sent, now), sup); // fuse with who YOU show up with
    const body = document.createElement("div"); body.className = "ins-body";
    if (totalScored < SUP_GLOBAL_THIN) {
      const s = document.createElement("div"); s.className = "ins-learn";
      s.textContent = `Still learning who shows up for you — ${totalScored}/${SUP_GLOBAL_THIN} replies & mentions seen. Open your notifications a few times and I'll map them.`;
      body.append(s);
    } else {
      const truncated = inbound.length >= SUPPORTERS_MAX;
      const arrow = (t: ReturnType<typeof supCadence>) => (t === "up" ? "↑" : t === "down" ? "↓" : t === "flat" ? "→" : "");
      for (const r of ranked) {
        const row = document.createElement("div"); row.className = "ins-row";
        const av = avatarChip(r.handle, r.avatar); av.style.cursor = "pointer"; av.title = `Open @${r.handle}`;
        av.onclick = () => window.open(`https://x.com/${r.handle}`, "_blank", "noopener");
        row.append(av);
        const mid = document.createElement("div"); mid.className = "ins-mid";
        const top = document.createElement("div"); top.className = "ins-top";
        const h = document.createElement("a") as HTMLAnchorElement; h.className = "ins-h"; h.textContent = "@" + r.handle; h.href = `https://x.com/${r.handle}`; h.target = "_blank"; h.rel = "noopener"; h.style.textDecoration = "none";
        top.append(h);
        const tr = arrow(supCadence(inbound, r.handle, now, truncated));
        if (tr) { const a = document.createElement("span"); a.className = "ins-ar"; a.textContent = tr; a.title = "how often they've engaged you lately"; top.append(a); }
        const rb = relBadge(rel[r.handle]?.rel ?? "acquaintance");
        if (rb) { const b = document.createElement("span"); b.className = `ins-rel ${rb.cls}`; b.textContent = rb.text; top.append(b); }
        if (r.thin) { const b = document.createElement("span"); b.className = "ins-thin"; b.textContent = "thin"; top.append(b); }
        mid.append(top);
        const meta = document.createElement("div"); meta.className = "ins-meta";
        const days = Math.max(0, Math.round((now - r.lastAt) / (24 * HOUR_MS)));
        const bits: string[] = [];
        if (r.replies) bits.push(`replied ${r.replies}×`);
        if (r.mentions) bits.push(`mentioned ${r.mentions}×`);
        bits.push(`last ${days}d`);
        if (r.followers) bits.push(`${fmtCount(r.followers)} followers`);
        meta.textContent = bits.join(" · ");
        meta.title = "Replies & mentions I saw in your notifications" + (r.followers ? "; their follower count when seen — not a reach estimate." : ".");
        mid.append(meta);
        row.append(mid);
        const pips = document.createElement("div"); pips.className = "ins-pips"; pips.textContent = "●".repeat(r.confidence) + "○".repeat(3 - r.confidence); pips.title = "how much they've shown up — not a prediction"; row.append(pips);
        body.append(row);
      }
      // anti-pod ring guard — a closed reciprocal loop is what X actually penalizes.
      const ring = reciprocalConcentration(inbound, replyLog.sent.filter((s) => s.author).map((s) => s.author as string), now);
      if (ring) { const n = document.createElement("div"); n.className = "ins-nudge"; n.textContent = `${Math.round(ring.pct * 100)}% of your recent replies go to accounts who engage you back. If it's a closed loop, X reads it as a pod and throttles everyone — bring in fresh accounts.`; body.append(n); }
      if (learning.length) { const more = document.createElement("div"); more.className = "ins-more"; more.textContent = `+${learning.length} still warming up`; body.append(more); }
      const foot = document.createElement("div"); foot.className = "ins-foot";
      foot.textContent = "A sample from your notifications, not a complete list — likes aren't counted (X hides most likers). Tap to open a profile and engage when their posts are relevant. Not a favor to repay: liking back to earn a like is exactly what X penalizes. Your notifications stay on your device.";
      body.append(foot);
    }
    wrap.append(body);
  }
  d.append(wrap);
}

/** Secondary relationship analytics. The actionable reply/mention queue graduated to the primary
 *  Comments workspace; this compact accordion now contains only Circle and Supporters context. */
function renderRelationshipTabs(d: HTMLElement): void {
  const now = Date.now();
  const invAgg = aggregateAccounts(replyLog.sent, now);
  const invRanked = rankAccounts(invAgg).ranked.length;
  const invLearning = invAgg.attributed < GLOBAL_THIN;
  let supScored = 0; const supHandles = new Set<string>();
  for (const e of inbound) if (e.kind === "reply" || e.kind === "mention") { supScored++; supHandles.add(e.handle); }
  const supLearning = supScored < SUP_GLOBAL_THIN;

  // Relationships matter, but they are supporting context for the reply queue. One
  // quiet summary replaces the permanently visible three-tab analytics layer.
  const summary = document.createElement("button"); summary.className = "rel-summary";
  summary.setAttribute("aria-expanded", String(relationshipsOpen));
  const summaryTitle = document.createElement("span"); summaryTitle.className = "rel-summary-title"; summaryTitle.textContent = relationshipsOpen ? "‹ Back to replies" : "Relationships";
  const facts = document.createElement("span"); facts.className = "rel-summary-facts";
  const factBits = [!invLearning ? `${invRanked} in your circle` : "", !supLearning ? `${supHandles.size} supporters` : ""].filter(Boolean);
  facts.textContent = relationshipsOpen ? "Circle and supporters" : (factBits.join(" · ") || "Insights appear as you reply");
  const caret = document.createElement("span"); caret.className = "rel-summary-caret"; caret.textContent = relationshipsOpen ? "▾" : "▸";
  summary.append(summaryTitle, facts, caret);
  summary.onclick = () => { relationshipsOpen = !relationshipsOpen; renderDock(); };
  d.append(summary);
  if (!relationshipsOpen) return;

  const tabs = document.createElement("div"); tabs.className = "rel-tabs"; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Relationships");
  const mkTab = (id: Exclude<RelTab, null>, label: string, tip: string, badge: string | null, amber: boolean) => {
    const on = relTab === id;
    const b = document.createElement("button"); b.className = "rel-tab" + (on ? " on" : "");
    b.title = tip; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(on)); b.setAttribute("aria-expanded", String(on));
    const t = document.createElement("span"); t.textContent = label; b.append(t);
    if (badge) { const bd = document.createElement("span"); bd.className = "rel-badge" + (amber ? " amber" : ""); bd.textContent = badge; b.append(bd); }
    b.onclick = () => { relTab = on ? null : id; renderDock(); };
    return b;
  };
  tabs.append(mkTab("invest", "Your circle", "Who you show up with — the accounts your replies invest in, upgraded to measured (✓) as outcomes settle.", invLearning ? null : String(invRanked), false));
  tabs.append(mkTab("supporters", "Supporters", "Who shows up for you — accounts that reply to / mention you (from your notifications).", supLearning ? null : String(supHandles.size), false));
  d.append(tabs);

  if (relTab === "invest") renderInsightPanel(d);
  else if (relTab === "supporters") renderSupportersPanel(d);
}

let apiAlive: boolean | undefined; // session cache: undefined = unknown, true = verified working, false = shape looks dead
/** Tell a genuinely quiet niche apart from a DEAD integration (key on the wrong provider, a
 *  renamed param, or a bumped endpoint version — all of which return HTTP 200 + an empty body
 *  that parses to []). One cheap known-good search that MUST return results if the API is healthy. */
async function verifyApiAlive(): Promise<boolean> {
  if (apiAlive !== undefined) return apiAlive;
  const res = await send<{ ok?: boolean; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "search-v3", query: { type: "Latest", count: "5", query: "the" }, intent: true });
  if (res?.error) return true; // a config/budget error is a different, already-surfaced failure — not a dead shape
  apiAlive = !!res?.ok && parseTimelineTweets(res.data).length > 0;
  return apiAlive;
}

async function generateIdeas() {
  if (ideasLoading) return;
  const niche = xNiche.trim();
  if (!niche) { toast("Set your niche in the Goobi panel so it knows your space."); return; }
  ideasLoading = true; ideasError = undefined; renderDock();
  goobiDrafting = true; refreshGoobi(); // Goobi thinks while Claude writes ideas
  try {
    // Latest (not Top): Top returns all-time bangers that are often months old and undated, which
    // the recency window drops — Latest gives RECENT posts and pickBest's breakout score + floor
    // surfaces the ones over-performing right now. Operators drop replies/retweets/giveaways server-side.
    const runSearch = (q: string) => send<{ ok?: boolean; status?: number; data?: unknown; error?: string }>({
      type: "TWTTR_GET", path: "search-v3", query: { type: "Latest", count: "40", query: q }, intent: true,
    });
    const search = await runSearch(nicheSearchQuery(niche, "lang:en -filter:replies -filter:nativeretweets -filter:retweets -giveaway"));
    if (search?.error === "no-twttr-config") { ideasError = "Add your RapidAPI key in the Goobi panel to gather niche posts."; return; }
    if (search?.error?.startsWith("budget-")) { ideasError = "The local/provider X-data safety budget is nearly used — ideas are paused. Check RapidAPI for the billing-cycle reset."; return; }
    if (!search?.ok) { ideasError = `Couldn't pull niche posts${search?.status ? ` (HTTP ${search.status})` : ""}. Try again.`; return; }
    const parsed = parseTimelineTweets(search.data);
    setRateTable(calibrateRates(parsed)); // tune the size-tiered baseline to THIS niche from the posts just fetched (free — no new API call; sparse tiers keep the published default)
    let winners = pickBest(parsed, 10);
    if (parsed.length < 15 || !winners.length) { // thin pool → one BROADER retry: the single strongest topic, raw (also dodges any provider quirk with OR/parens)
      const raw2 = await runSearch((nicheTopics(niche)[0] ?? niche).slice(0, 90));
      if (raw2?.ok) { const w2 = pickBest(parseTimelineTweets(raw2.data), 10); if (w2.length > winners.length) winners = w2; }
    }
    if (!winners.length) { ideasError = (await verifyApiAlive()) ? "Didn't find enough strong posts in your niche. Use fewer, broader keywords in your niche setting (e.g. \"AI, SaaS, founders\") — the words before the \";\" drive the search." : "The X-data API returned nothing usable — your RapidAPI key may not be subscribed to the right provider (twitter241). Check your subscription in the popup."; return; }
    const ownPosts = await getOwnPosts(); // cheap (cached ~24h, [] if no handle) — voice anchor + de-dupe
    const resp = await send<{ ideas?: { text: string; source: string; pattern: string; why: string; critique: string; hookStrength: number; grade?: IdeaGrade }[]; error?: string }>({
      type: "POST_IDEAS",
      posts: winners.map((t) => ({ author: t.author, text: t.text, likes: t.likes, reposts: t.reposts, followers: t.followers, shape: t.shape })),
      ownPosts,
      followers: myFollowers || undefined,
      shapeLine: (measuredIdeaShapeLine() ?? measuredShapeLine())?.line,
      strategyLine: (() => { const gx = activeGrowthExperiment(growthStore); if (!gx) return undefined; const s = growthStrategy(gx.strategyId); return `${s.label}. Hypothesis: ${s.hypothesis} Post brief: ${s.postBrief}`; })(),
    });
    if (resp?.error === "no-key") { ideasError = "Add your Anthropic key in the Goobi panel to write post ideas."; return; }
    if (!resp || resp.error || !resp.ideas?.length) { ideasError = resp?.error ? `Couldn't write ideas: ${friendlyErr(resp.error)}` : "Couldn't write ideas — try again."; return; }
    // Attach the REAL source post (already in `winners`) by matching the handle the model cited, and
    // anchor the honest virality band to that source's measured RANK in the pool.
    const now = Date.now();
    const norm = (s: string) => s.toLowerCase().replace(/[@\s]/g, "").replace(/[.,!?]+$/, "");
    const fresh: IdeaRecord[] = resp.ideas.map((d) => {
      const handle = (d.source || "").trim();
      let w: IdeaWinner | undefined; let rank = -1;
      if (handle) {
        // Exact + normalized-exact only — a loose prefix match could attach the WRONG proof post
        // ("sam" → @sammylens) and inflate the band. A non-match correctly falls to no-source → Niche.
        w = winners.find((x) => x.author.toLowerCase() === handle.toLowerCase())
          ?? winners.find((x) => norm(x.author) === norm(handle));
        if (w) rank = winners.indexOf(w);
      }
      const anchor = rank >= 0 ? 1 - rank / Math.max(1, winners.length - 1) : 0; // #1 winner → 1.0
      const sourceStrong = w && (w.followers ?? 0) > 0 ? isBreakout(w) : undefined; // real over-performer vs its size, not just rank #1
      const { band, sort, basis } = bandFor(anchor, d.hookStrength ?? 0, !!w, winners.length, sourceStrong); // poolSize → thin-pool haircut; sourceStrong → Strong needs a real breakout
      return { id: newIdeaId(), text: d.text, source: d.source, pattern: d.pattern, why: d.why,
        band, basis, sortScore: sort, grade: d.grade,
        shape: classifyShape(d.text),
        src: w ? { handle: w.author, id: w.id, text: w.text, likes: w.likes, reposts: w.reposts, views: w.views } : undefined,
        origin: "generated", status: "working", createdAt: now, lastEditedAt: now };
    });
    // Drop a fresh idea that duplicates one of YOUR recent posts, an earlier sibling, OR a working idea
    // already in the queue (cross-batch dedup).
    const ownTok = ownPosts.map((p) => ideaTokens(p.text));
    const keptTok: Set<string>[] = ideaQueue.filter((r) => r.status === "working").map((r) => ideaTokens(r.text));
    const deduped = fresh.filter((rec) => {
      if (rec.src && copyLeak(rec.text, rec.src.text) >= COPY_LEAK) return false; // lifted the source's content, not its pattern
      const tk = ideaTokens(rec.text);
      if (ownTok.some((o) => jaccard(tk, o) >= TOO_SIMILAR)) return false;
      if (keptTok.some((k) => jaccard(tk, k) >= TOO_SIMILAR)) return false;
      keptTok.push(tk); return true;
    });
    ideaQueue = [...(deduped.length ? deduped : fresh), ...ideaQueue]; // newest batch on top (keep all if de-dupe nuked everything)
    persistIdeas();
  } finally {
    ideasLoading = false; goobiDrafting = false; refreshGoobi(); renderDock();
  }
}

const BAND_COLOR: Record<Band, string> = { "Strong": "#6fcf7f", "Solid": "#e0a45c", "Niche": "#c9b79a", "Long shot": "#8c7d68" };
/** Render view for an idea's honest virality band. New records carry band/basis; old persisted
 *  records (pre-band) fall back from the legacy 0-100 virality. */
function ideaBandView(idea: IdeaRecord): { band: Band; color: string; basis: string } {
  let band = idea.band;
  if (!band) { const v = idea.virality ?? 50; band = v >= 70 ? "Strong" : v >= 45 ? "Solid" : "Niche"; }
  return { band, color: BAND_COLOR[band], basis: idea.basis || "Goobi's read on how far this could go." };
}
function togglePin(rec: IdeaRecord): void { rec.pinned = !rec.pinned; rec.lastEditedAt = Date.now(); persistIdeas(); renderDock(); }
function deleteIdea(rec: IdeaRecord): void {
  ideaQueue = ideaQueue.filter((i) => i.id !== rec.id);
  expandedIdeas.delete(rec.id); expandedSources.delete(rec.id); ideaUndo.delete(rec.id);
  persistIdeas(); renderDock();
}
function markPosted(rec: IdeaRecord, posted: boolean): void {
  rec.status = posted ? "posted" : "working";
  rec.postedAt = posted ? Date.now() : undefined;
  if (posted) clearReminderFields(rec); // a shipped draft's reminder is served (chip + badge clear)
  if (!posted) { rec.publication = undefined; rec.growthExperimentId = undefined; rec.growthStrategyId = undefined; }
  else tagIdeaGrowth(rec, rec.postedAt);
  if (posted) reconcileIdeasWithOwnPosts();
  if (posted) goobiReact("cheer", "Posted! 🎉", "saved to your history", 3200);
  persistIdeas(); renderDock();
}
/** Consecutive days you've shipped a post (today or yesterday anchored), like the reply streak. */
function postedStreak(): number {
  const days = new Set(ideaQueue.filter((i) => i.status === "posted" && i.postedAt).map((i) => dayKey(i.postedAt!)));
  if (!days.size) return 0;
  let s = 0;
  for (let i = days.has(dayKey(Date.now())) ? 0 : 1; ; i++) { if (days.has(dayKey(Date.now() - i * DAY_MS))) s++; else break; }
  return s;
}
/** Working drafts, pinned-first then newest then strongest. */
function workingIdeas(): IdeaRecord[] {
  const tierRank = (i: IdeaRecord) => TIER_UI[i.grade?.tier ?? ""]?.rank ?? 1; // ungraded sorts with "ok"
  return ideaQueue.filter((i) => i.status === "working")
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || tierRank(a) - tierRank(b) || b.createdAt - a.createdAt || (b.sortScore ?? 0) - (a.sortScore ?? 0));
}
function postedIdeas(): IdeaRecord[] { return ideaQueue.filter((i) => i.status === "posted").sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0)); }

/* ---------- draft-and-remind: schedule a nudge to ship a draft (never a post) ----------
 * The pure math lives in lib/schedule.ts. Here: set/clear on the record (persisted via the
 * existing X_IDEAS_KEY), a 30s due-watcher that toasts ONCE per schedule and highlights the
 * card, and the picker UI. The service worker mirrors the due count on the toolbar badge.
 * Clicking through uses the EXISTING ship path (Open in X ↗) — user-clicked only. */

/** Minutes since the user's last own original (same read the momentum strip uses). */
function minsSinceLastOwnPost(): number | undefined {
  const lastPost = ideaQueue.reduce((mx, i) => (i.postedAt && i.postedAt > mx ? i.postedAt : mx), 0);
  return lastPost ? (Date.now() - lastPost) / 60000 : undefined;
}

function setReminder(rec: IdeaRecord, at: number): void {
  rec.remindAt = at; rec.remindedAt = undefined; rec.lastEditedAt = Date.now();
  remindPickerOpen.delete(rec.id);
  persistIdeas(); renderDock();
  toast(`⏰ Reminder set for ${formatSlot(at, Date.now())}. Goobi will highlight the draft and badge the toolbar — posting stays your click.`);
}

/** The reminder has served its purpose (shipped / opened / cleared) — stop chipping + badging. */
function clearReminderFields(rec: IdeaRecord): boolean {
  if (rec.remindAt == null && rec.remindedAt == null) return false;
  rec.remindAt = undefined; rec.remindedAt = undefined;
  return true;
}

/** Fire due reminders: the card highlight is ambient (render), the toast fires ONCE per
 *  schedule (remindedAt gates it, persisted so another tab won't re-toast). Draft-only:
 *  nothing opens and nothing posts — the user clicks through from the Ideas tab. */
function checkDueReminders(): void {
  if (invalidated) return;
  const now = Date.now();
  let fired = false;
  for (const rec of ideaQueue) {
    if (rec.status !== "working" || rec.remindAt == null || rec.remindAt > now || rec.remindedAt != null) continue;
    rec.remindedAt = now; fired = true;
    toast(reminderToastLine(rec.text, minsSinceLastOwnPost())); // soft spacing note when relevant
  }
  if (fired) { persistIdeas(); if (!dockInputFocused()) renderDock(); }
}

/** Rewrite ONE idea per a steer, in place — a single scoped Claude call, with one-level undo. */
async function rewriteIdea(rec: IdeaRecord, steer: string): Promise<void> {
  if (ideaBusy.has(rec.id) || !steer.trim()) return;
  ideaBusy.add(rec.id); goobiDrafting = true; refreshGoobi(); renderDock();
  const prior = rec.text;
  const resp = await send<{ text?: string; error?: string }>({ type: "POST_IDEA_REWRITE", text: rec.text, steer: steer.trim(), source: rec.src?.text, pattern: rec.pattern });
  ideaBusy.delete(rec.id); goobiDrafting = false; refreshGoobi();
  if (resp?.text) { ideaUndo.set(rec.id, prior); rec.text = resp.text; rec.grade = undefined; rec.lastEditedAt = Date.now(); persistIdeas(); } // clear the now-stale grade (its call-out described the old text)
  else toast(resp?.error === "no-key" ? "Add your Anthropic key to rewrite ideas." : "Rewrite failed — try again.");
  renderDock();
}

/** The quick-shape row: steer chips + a free nudge + undo. */
function steerRow(rec: IdeaRecord): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "idea-steer";
  if (ideaBusy.has(rec.id)) { const b = document.createElement("div"); b.className = "idea-steerbusy"; b.textContent = "✨ Goobi's rewriting this one…"; wrap.append(b); return wrap; }
  const CHIPS: [string, string][] = [["Punchier", "punchier, sharper hook"], ["Shorter", "shorter and tighter"], ["+ number", "add a specific number or concrete detail"], ["More me", "more in my own voice, less generic"]];
  for (const [label, steer] of CHIPS) { const b = document.createElement("button"); b.className = "idea-chip"; b.textContent = label; b.onclick = () => void rewriteIdea(rec, steer); wrap.append(b); }
  if (ideaUndo.has(rec.id)) { const u = document.createElement("button"); u.className = "idea-chip idea-undo"; u.textContent = "↶ Undo"; u.title = "Revert the last rewrite"; u.onclick = () => { const p = ideaUndo.get(rec.id); if (p != null) { rec.text = p; ideaUndo.delete(rec.id); rec.lastEditedAt = Date.now(); persistIdeas(); renderDock(); } }; wrap.append(u); }
  const inp = document.createElement("input"); inp.className = "idea-steerin"; inp.type = "text"; inp.placeholder = "or nudge it…";
  inp.onkeydown = (e) => { if (e.key === "Enter" && inp.value.trim()) { e.preventDefault(); void rewriteIdea(rec, inp.value); } };
  wrap.append(inp);
  return wrap;
}

/** yyyy-MM-ddTHH:mm in LOCAL time, for the datetime-local custom picker. */
function dtLocalValue(ts: number): string {
  const d = new Date(ts); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Draft-and-remind row: pick a suggested spaced slot (✦ = prior, not a measured best
 *  time) or a custom time. A reminder only highlights + badges — it never posts,
 *  never auto-opens anything. */
function remindRow(rec: IdeaRecord): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "idea-remind";
  const rs = reminderState(rec, Date.now());
  if (!remindPickerOpen.has(rec.id)) {
    if (rs === "none") {
      const b = document.createElement("button"); b.className = "idea-pin"; b.textContent = "⏰ Remind me";
      b.title = "Schedule a nudge to ship this draft. Goobi highlights it in the dock and badges the toolbar — it never auto-posts.";
      b.onclick = () => { remindPickerOpen.add(rec.id); renderDock(); };
      wrap.append(b);
    } else {
      const lbl = document.createElement("span"); lbl.className = "idea-remind-chip" + (rs === "overdue" ? " overdue" : "");
      lbl.textContent = rs === "scheduled" ? `⏰ Reminder ${formatSlot(rec.remindAt!, Date.now())}` : rs === "due" ? "⏰ Reminder due now" : `⏰ Reminder overdue (${formatSlot(rec.remindAt!, Date.now())})`;
      const change = document.createElement("button"); change.className = "idea-pin"; change.textContent = "Change";
      change.onclick = () => { remindPickerOpen.add(rec.id); renderDock(); };
      const clr = document.createElement("button"); clr.className = "idea-pin"; clr.textContent = "Clear";
      clr.title = "Drop the reminder — the draft itself stays put.";
      clr.onclick = () => { if (clearReminderFields(rec)) { rec.lastEditedAt = Date.now(); persistIdeas(); renderDock(); } };
      wrap.append(lbl, change, clr);
    }
    return wrap;
  }
  // Picker open: suggested slots (spacing-aware, all priors) + a custom time.
  const slots = nextShipSlots({ now: Date.now(), minsSinceLastOwnPost: minsSinceLastOwnPost(), queue: ideaQueue, excludeId: rec.id });
  for (const s of slots) {
    const b = document.createElement("button"); b.className = "idea-chip"; b.textContent = `✦ ${s.label}`; b.title = s.note;
    b.onclick = () => setReminder(rec, s.at);
    wrap.append(b);
  }
  const dt = document.createElement("input"); dt.className = "idea-remind-dt"; dt.type = "datetime-local";
  dt.min = dtLocalValue(Date.now()); dt.setAttribute("aria-label", "Custom reminder time");
  const set = document.createElement("button"); set.className = "idea-chip"; set.textContent = "Set";
  set.onclick = () => {
    const at = dt.value ? new Date(dt.value).getTime() : NaN;
    if (!Number.isFinite(at) || at <= Date.now()) { toast("Pick a future time for the reminder."); return; }
    setReminder(rec, at);
  };
  const cancel = document.createElement("button"); cancel.className = "idea-pin"; cancel.textContent = "Cancel";
  cancel.onclick = () => { remindPickerOpen.delete(rec.id); renderDock(); };
  wrap.append(dt, set, cancel);
  const note = document.createElement("div"); note.className = "idea-remind-note";
  note.textContent = "✦ = a prior (common posting windows + ~3h spacing between originals), not a measured best time. The reminder highlights this draft and badges the toolbar — posting stays your click.";
  wrap.append(note);
  return wrap;
}

/** Source proof shown inside the card's single "Why this suggestion" disclosure. */
function sourceBlock(idea: IdeaRecord): HTMLElement {
  const wrap = document.createElement("div");
  if (!idea.src) {
    const s = document.createElement("div"); s.className = "idea-src";
    s.textContent = idea.origin === "seed" ? `Built from your rough idea${idea.pattern ? ` · ${idea.pattern}` : ""}` : `↺ Pattern borrowed from your niche${idea.pattern ? ` · ${idea.pattern}` : ""}`;
    wrap.append(s); return wrap;
  }
  const s = document.createElement("div"); s.className = "idea-src"; s.textContent = `Source pattern · @${idea.src.handle}${idea.pattern ? ` · ${idea.pattern}` : ""}`; wrap.append(s);
  const q = document.createElement("div"); q.className = "idea-quote";
  const qt = document.createElement("div"); qt.className = "idea-qtext"; qt.textContent = idea.src.text; q.append(qt);
  const f = document.createElement("div"); f.className = "idea-qfoot";
  const eng = document.createElement("span"); eng.textContent = `❤ ${fmtCount(idea.src.likes) || 0} · 🔁 ${fmtCount(idea.src.reposts) || 0}${idea.src.views != null ? ` · 👁 ${fmtCount(idea.src.views)}` : ""}`;
  const link = document.createElement("a"); link.className = "idea-qlink"; link.textContent = "View source ↗";
  link.href = `https://x.com/${idea.src.handle}/status/${idea.src.id}`; link.target = "_blank"; link.rel = "noopener";
  f.append(eng, link); q.append(f); wrap.append(q);
  return wrap;
}

/** Open X's composer prefilled with the edited draft. Opening is not proof of
 * posting, so the draft stays working until the user explicitly marks it Posted. */
function openInComposer(idea: IdeaRecord, _shipped: boolean): void {
  window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(idea.text)}`, "_blank", "noopener");
  if (clearReminderFields(idea)) { idea.lastEditedAt = Date.now(); persistIdeas(); renderDock(); } // clicking through serves the reminder
}
const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find(Boolean) || s;

const TIER_UI: Record<string, { icon: string; color: string; label: string; rank: number }> = {
  strong: { icon: "✓", color: "#6fcf7f", label: "strong", rank: 0 },
  ok:     { icon: "~", color: "#a89a85", label: "ok",     rank: 1 },
  weak:   { icon: "!", color: "#e89a3c", label: "weak",   rank: 2 },
};

function publicationMetrics(p: IdeaPublication): string {
  const bits: string[] = [];
  if (p.views != null) bits.push(`${fmtCount(p.views)} views`);
  if (p.likes != null) bits.push(`${fmtCount(p.likes)} likes`);
  if (p.replies != null) bits.push(`${fmtCount(p.replies)} replies`);
  if (p.reposts != null) bits.push(`${fmtCount(p.reposts)} reposts`);
  return bits.join(" · ");
}

/** A scannable idea ROW: virality rail + one-line hook + source meta + one-tap ↗. Click the
 *  row to expand IN PLACE into the editor (draft hero + why + steer + source + actions). */
function ideaCard(idea: IdeaRecord, opts?: { shipped?: boolean }): HTMLElement {
  const shipped = !!opts?.shipped;
  const open = expandedIdeas.has(idea.id);
  const vv = ideaBandView(idea);
  const rs = shipped ? "none" : reminderState(idea, Date.now()); // draft-and-remind chip/highlight state
  const c = document.createElement("div"); c.className = "idea";
  if (open) c.classList.add("open");
  if (idea.pinned && !shipped) c.classList.add("kept");
  if (shipped) c.classList.add("shipped");
  if (ideaBusy.has(idea.id)) c.classList.add("busy");
  if (rs === "due" || rs === "overdue") c.classList.add("remind-due"); // due reminder → the card glows amber
  // Click the collapsed row (or the hook when open) to toggle — single-open.
  const toggle = () => { const was = expandedIdeas.has(idea.id); expandedIdeas.clear(); if (!was) expandedIdeas.add(idea.id); renderDock(); };
  c.onclick = toggle;

  // Main column — a readable preview and one human quality line.
  const main = document.createElement("div"); main.className = "idea-main"; main.setAttribute("role", "button"); main.tabIndex = 0; main.setAttribute("aria-expanded", String(open));
  main.setAttribute("aria-label", `${open ? "Collapse" : "Edit"} post idea: ${firstLine(idea.text)}`);
  main.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(); } };
  const hook = document.createElement("div"); hook.className = "idea-hook"; hook.textContent = idea.text; main.append(hook);
  const meta = document.createElement("div"); meta.className = "idea-meta";
  if (shipped && idea.publication) {
    const metrics = publicationMetrics(idea.publication);
    meta.textContent = `✓ Matched on X${metrics ? ` · ${metrics}` : " · measurement pending"}`;
    meta.title = "Exact text match to your real post from RapidAPI — these measured results can safely improve future ideas.";
  } else if (shipped) {
    meta.textContent = "Posted manually · waiting for an exact X match";
    meta.title = "Goobi only attributes a result when one real post uniquely matches this text. Edited or ambiguous posts stay unclaimed.";
  } else if (idea.grade) {
    const t = TIER_UI[idea.grade.tier] ?? TIER_UI.ok;
    const chip = document.createElement("b"); chip.textContent = `${t.icon} ${t.label === "ok" ? "Worth editing" : t.label === "strong" ? "Strong draft" : "Needs a personal detail"}`; chip.style.color = t.color;
    chip.title = `Quality: how much this reads as uniquely YOU (vs generic niche filler). Graded by the same judge that drives the auto-rewrite. Separate from the virality band (that's the source post's reach).`;
    meta.append(chip);
    if (idea.grade.callout) { const co = document.createElement("span"); co.textContent = " · " + idea.grade.callout; co.title = idea.grade.callout + (idea.grade.lever ? ` — aimed at a ${idea.grade.lever}` : ""); meta.append(co); }
  } else {
    meta.textContent = idea.origin === "seed" ? "Your draft · built from your rough idea" : idea.src ? `Suggested from a pattern working in your niche` : "Niche suggestion · ready for your edit";
  }
  if (rs !== "none") { // the reminder chip rides the meta line (due/overdue escalate the color)
    const chip = document.createElement("b"); chip.className = "idea-remind-chip" + (rs === "overdue" ? " overdue" : "");
    chip.textContent = rs === "scheduled" ? `⏰ ${formatSlot(idea.remindAt!, Date.now())}` : rs === "due" ? "⏰ due now" : `⏰ overdue (${formatSlot(idea.remindAt!, Date.now())})`;
    chip.title = "Your ship reminder for this draft. Goobi highlights it and counts it on the toolbar badge — opening the composer is always your click.";
    if (meta.firstChild) meta.insertBefore(document.createTextNode(" · "), meta.firstChild);
    meta.insertBefore(chip, meta.firstChild);
  }
  main.append(meta); c.append(main);

  // One clear collapsed action: edit. Publishing stays inside the editor.
  const rowact = document.createElement("div"); rowact.className = "idea-rowact";
  const edit = document.createElement("button"); edit.className = "idea-edit"; edit.textContent = open ? "Close" : "Edit"; edit.setAttribute("aria-expanded", String(open));
  edit.onclick = (e) => { e.stopPropagation(); toggle(); };
  rowact.append(edit); c.append(rowact);

  // Expandable body — the editor.
  const body = document.createElement("div"); body.className = "idea-body";
  body.onclick = (e) => e.stopPropagation(); // editing must never collapse the card
  const draftLabel = document.createElement("label"); draftLabel.className = "idea-draft-label"; draftLabel.textContent = "Draft";
  const ta = document.createElement("textarea"); ta.className = "idea-ta"; ta.value = idea.text; ta.setAttribute("aria-label", "Editable post draft");
  ta.rows = Math.min(10, Math.max(3, idea.text.split("\n").length + Math.ceil(idea.text.length / 42)));
  const autosize = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.oninput = () => { idea.text = ta.value; hook.textContent = ta.value; autosize(); };
  ta.onchange = () => { idea.lastEditedAt = Date.now(); persistIdeas(); };
  body.append(draftLabel, ta);
  if (open) requestAnimationFrame(autosize); // size to content once it's visible
  if (idea.grade?.callout) { const qn = document.createElement("div"); qn.className = "idea-quality"; qn.textContent = idea.grade.tier === "strong" ? `Strong: ${idea.grade.callout}` : idea.grade.callout; body.append(qn); }
  if (!shipped) { body.append(steerRow(idea)); body.append(remindRow(idea)); } // quick-shape + remind-me (working drafts only)
  if (shipped && idea.publication) {
    const outcome = document.createElement("div"); outcome.className = "idea-outcome";
    const link = document.createElement("a"); link.href = `https://x.com/i/status/${idea.publication.postId}`; link.target = "_blank"; link.rel = "noopener"; link.textContent = "✓ Exact post matched on X ↗";
    const metrics = publicationMetrics(idea.publication);
    outcome.append(link, document.createTextNode(metrics ? ` · ${metrics}` : " · X has not reported metrics yet"));
    outcome.title = "Measured through RapidAPI. Counts refresh with your cached own-post scan; no extra API request is made for attribution.";
    body.append(outcome);
  }
  const whyOpen = expandedSources.has(idea.id);
  const whyToggle = document.createElement("button"); whyToggle.className = "idea-why-toggle"; whyToggle.textContent = `Why this suggestion ${whyOpen ? "▾" : "▸"}`; whyToggle.setAttribute("aria-expanded", String(whyOpen));
  whyToggle.onclick = () => { whyOpen ? expandedSources.delete(idea.id) : expandedSources.add(idea.id); renderDock(); };
  body.append(whyToggle);
  if (whyOpen) {
    const details = document.createElement("div"); details.className = "idea-details";
    if (idea.why) { const w = document.createElement("div"); w.className = "idea-why"; w.textContent = idea.why; details.append(w); }
    const band = document.createElement("div"); band.className = "idea-detail-meta"; band.textContent = `${vv.band} potential · ${vv.basis}`; details.append(band, sourceBlock(idea));
    body.append(details);
  }
  const actions = document.createElement("div"); actions.className = "idea-actions";
  const openBtn = document.createElement("button"); openBtn.className = "idea-open"; openBtn.textContent = "Open in X ↗";
  openBtn.title = "Opens X's composer with your edited draft prefilled — you review and post. An exact RapidAPI match can move it to Posted on the next stats refresh.";
  openBtn.onclick = () => openInComposer(idea, shipped);
  const copy = document.createElement("button"); copy.className = "idea-copy"; copy.textContent = "Copy";
  copy.onclick = async () => { try { await navigator.clipboard.writeText(idea.text); copy.textContent = "Copied ✓"; setTimeout(() => (copy.textContent = "Copy"), 1400); } catch { /* ignore */ } };
  actions.append(openBtn, copy);
  const quiet = document.createElement("div"); quiet.className = "idea-quiet-actions";
  if (shipped) {
    const back = document.createElement("button"); back.className = "idea-pin"; back.textContent = "Move to drafts"; back.title = "Move back to working drafts (didn't post it)";
    back.onclick = () => markPosted(idea, false); quiet.append(back);
  } else {
    const pin = document.createElement("button"); pin.className = "idea-pin" + (idea.pinned ? " on" : ""); pin.textContent = idea.pinned ? "Pinned" : "Pin";
    pin.title = idea.pinned ? "Kept — won't be replaced on a reroll." : "Keep this one — survives a reroll.";
    pin.onclick = () => togglePin(idea);
    const done = document.createElement("button"); done.className = "idea-pin"; done.textContent = "Posted"; done.title = "I posted this (e.g. via Copy) — move it to history now. Goobi will attach measured results after an exact X match.";
    done.onclick = () => markPosted(idea, true);
    const del = document.createElement("button"); del.className = "idea-pin idea-delete"; del.textContent = "Delete"; del.title = "Delete this draft"; del.onclick = () => deleteIdea(idea);
    quiet.append(pin, done, del);
  }
  actions.append(quiet);
  body.append(actions); c.append(body);
  return c;
}

function stopIdeasGoobi(): void {
  if (goobiIdeasTimer) { clearTimeout(goobiIdeasTimer); goobiIdeasTimer = undefined; }
  goobiIdeasHandle?.destroy(); goobiIdeasHandle = null;
}
/** A big Goobi who dances + cycles fun moves in the ideas loading area while Claude works.
 *  Mounted AFTER the dock is in the DOM (the canvas loop self-guards on isConnected). */
function mountIdeasGoobi(): void {
  stopIdeasGoobi();
  const stage = dockRoot?.querySelector<HTMLElement>(".idea-load");
  if (!stage) return;
  goobiIdeasHandle = mountGoobi(stage, { cell: 4, playful: true });
  goobiIdeasHandle.setMood("cheer");
  const dance = () => {
    if (!goobiIdeasHandle || !goobiIdeasHandle.el.isConnected || !ideasLoading) { stopIdeasGoobi(); return; }
    goobiIdeasHandle.trick(); // a fresh random move (dance/spin/flip/jump…) every beat
    goobiIdeasTimer = window.setTimeout(dance, 1150);
  };
  goobiIdeasTimer = window.setTimeout(dance, 350);
}

/* ---------- Target accounts: comment early on big in-reach niche accounts ---------- */
let targetStore: TargetStore = freshStore("");
const targetPosts = new Map<string, { id: string; text: string; postedAt?: number; author: string; replies?: number; likes?: number; reposts?: number; quotes?: number; views?: number }>(); // fetched latest post per handle; all provider metrics feed measured momentum
const targetDrafts = new Map<string, string>(); // generated reply draft per handle (session)
const targetBusy = new Set<string>();           // handles currently fetching/drafting
let targetAdding = false;
let targetAddMsg = "";
const dismissedSuggestions = new Set<string>(); // session-only (resets on reload) — "× not interested"
function persistTargets(): void { safeSet({ [CONFIG.X_TARGETS_KEY]: targetStore }); }

/* ---------- DM workspace: deliberate, draft-only relationship growth ---------- */
let dmStore: DmStore = freshDmStore("");
const dmExpanded = new Set<string>();
const dmBusy = new Set<string>();
const dmContextDrafts = new Map<string, string>();
let dmAdding = false;
let dmAddMsg = "";
let dmContextRefreshes = 0;
let dmPersistChain: Promise<void> = Promise.resolve();

function dmStorageKey(owner = dmStore.ownerHandle): string { return `${CONFIG.X_DM_WORKSPACE_KEY}:${owner.toLowerCase()}`; }
function persistDms(snapshot: DmStore = dmStore): void {
  const owner = snapshot.ownerHandle;
  if (!owner) return;
  dmPersistChain = dmPersistChain.then(async () => {
    const stored = await getLocal(dmStorageKey(owner)) as DmStore | undefined;
    const now = Date.now();
    const normalizedStored = pruneDmStore(stored, owner, now);
    const merged = mergeDmStores(normalizedStored, snapshot, owner, now);
    if (invalidated || !contextOK()) return;
    if (JSON.stringify(merged) !== JSON.stringify(normalizedStored)) {
      try { await chrome.storage.local.set({ [dmStorageKey(owner)]: merged }); } catch { return; }
    }
    if (dmStore.ownerHandle === owner) dmStore = mergeDmStores(dmStore, merged, owner, Date.now());
  }).catch(() => { /* best-effort local CRM persistence */ });
}
async function ensureDmOwner(): Promise<void> {
  const owner = (await myHandle()).toLowerCase();
  if (!owner) { if (dmStore.ownerHandle) { dmStore = freshDmStore(""); dmExpanded.clear(); dmContextDrafts.clear(); renderDock(); } return; }
  if (owner === dmStore.ownerHandle) return;
  dmStore = pruneDmStore(await getLocal(dmStorageKey(owner)) as DmStore | undefined, owner, Date.now());
  dmExpanded.clear(); dmContextDrafts.clear();
  if (dockView === "dms") renderDock();
}
function dmMutate(next: DmStore): void { dmStore = next; persistDms(); renderDock(); }
function dmAge(at?: number): string {
  if (!at) return "";
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60); if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
function dmDueLabel(candidate: DmCandidate): string {
  const at = candidate.snoozedUntil ?? candidate.dueAt; if (!at) return "";
  const days = Math.ceil((at - Date.now()) / DAY_MS);
  return days <= 0 ? "follow-up due" : candidate.snoozedUntil ? `snoozed ${days}d` : `follow-up in ${days}d`;
}

function dmSuggestions(): ReturnType<typeof rankDmSuggestions> {
  const owner = dmStore.ownerHandle;
  const inputs: DmSuggestionInput[] = [];
  for (const handle of Object.keys(relationshipMemory.owners[owner]?.accounts ?? {})) {
    const e = connectionEvidence(relationshipMemory, owner, handle, Date.now());
    if (!e) continue;
    const reach = authorReach.get(handle);
    inputs.push({ handle, followers: reach?.followers, bio: reach?.bio, source: "relationship", exactExchanges: e.completed, activeWeeks: e.activeWeeks, lastAt: e.lastAt });
  }
  if (targetStore.handle.toLowerCase() === owner) for (const target of targetStore.targets) {
    const reach = authorReach.get(target.handle.toLowerCase()), post = targetPosts.get(target.handle);
    inputs.push({ handle: target.handle, followers: target.followers, bio: reach?.bio, source: "target", publicContext: post?.text, lastAt: post?.postedAt });
  }
  return rankDmSuggestions(inputs, new Set(dmStore.candidates.map((c) => c.handle)), Date.now(), 5);
}

function planDm(input: Parameters<typeof addDmCandidate>[2]): void {
  const result = addDmCandidate(dmStore, dmStore.ownerHandle, input, Date.now());
  if (result.error && !result.candidate) { toast(result.error); return; }
  dmStore = result.store;
  if (result.candidate) { dmExpanded.add(result.candidate.handle); dmAddMsg = ""; }
  persistDms();
  if (dockView !== "dms") dockView = "dms";
  renderDock();
}

function planDmFromTarget(handle: string): void {
  if (targetStore.handle.toLowerCase() !== dmStore.ownerHandle) { toast("That Target list belongs to another configured account. Reopen Goobi on the current account first."); return; }
  const target = targetStore.targets.find((t) => t.handle.toLowerCase() === handle.toLowerCase());
  if (!target) return;
  const now = Date.now(), post = targetPosts.get(target.handle), reach = authorReach.get(target.handle.toLowerCase());
  planDm({ handle: target.handle, followers: target.followers, bioSnapshot: reach?.bio, source: "target", stage: "warming", intent: "connect",
    reasons: [{ id: `target:${target.handle}`, label: "Saved target · research before reaching out", detail: post?.text, source: post?.text ? "observed" : "user", capturedAt: now }],
    context: post?.text ? [{ id: `post:${post.id || now}`, kind: "public_post", source: "observed", text: post.text, postId: post.id, url: post.id ? `https://x.com/${target.handle}/status/${post.id}` : undefined, capturedAt: now }] : [],
  });
}

function planDmFromReplySpot(opportunity: Opp): void {
  const now = Date.now();
  const connection = connectionEvidence(relationshipMemory, dmStore.ownerHandle, opportunity.author, now);
  planDm({ handle: opportunity.author, name: opportunity.name, avatar: opportunity.avatar, followers: knownFollowers(opportunity),
    source: connection?.established ? "relationship" : "reply_spot", stage: connection?.established ? "ready" : "warming", intent: "connect",
    reasons: [{ id: `reply-spot:${opportunity.id}`, label: connection?.established ? `${connection.completed} exact exchanges across ${connection.activeWeeks} weeks` : "Relevant public post · warm up before moving private", detail: opportunity.text, source: connection?.established ? "measured" : "observed", sourceRef: opportunity.id, capturedAt: now }],
    context: [{ id: `post:${opportunity.id}`, kind: "public_post", source: "observed", text: opportunity.text, postId: opportunity.id, url: `https://x.com/${opportunity.author}/status/${opportunity.id}`, capturedAt: now }],
  });
}

async function addDmByHandle(raw: string, why: string): Promise<void> {
  if (dmAdding) return;
  const handle = raw.replace(/^@+/, "").trim();
  if (!handle) { dmAddMsg = "Enter an @handle."; renderDock(); return; }
  if (why.replace(/\s/g, "").length < 20) { dmAddMsg = "Add a specific ‘why now?’ note (at least 20 characters)."; renderDock(); return; }
  const owner = dmStore.ownerHandle;
  dmAdding = true; dmAddMsg = `Checking @${handle}…`; renderDock();
  let profile: ReturnType<typeof parseUser> = null;
  try {
    const res = await send<{ ok?: boolean; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "user", query: { username: handle }, intent: true });
    if (dmStore.ownerHandle !== owner) return;
    if (res?.ok) profile = parseUser(res.data);
    else if (res?.error && res.error !== "no-twttr-config") { dmAddMsg = `Couldn't refresh @${handle}; saved from your note instead.`; }
    const now = Date.now();
    const result = addDmCandidate(dmStore, owner, {
      handle: profile?.handle || handle, name: profile?.name, userId: profile?.id, followers: profile?.followers, bioSnapshot: profile?.bio,
      source: "manual", stage: "research", goal: why, intent: "connect",
      reasons: [{ id: `note:${now}`, label: "Why now", detail: why, source: "user", capturedAt: now }],
      context: profile?.bio ? [{ id: `profile:${profile.id || now}`, kind: "profile", source: "observed", text: profile.bio, capturedAt: now }] : [],
    }, now);
    dmStore = result.store;
    if (result.error) dmAddMsg = result.error;
    else if (result.candidate) { dmExpanded.add(result.candidate.handle); dmAddMsg = ""; persistDms(); }
  } finally { dmAdding = false; renderDock(); }
}

async function refreshDmContext(handle: string): Promise<void> {
  if (dmBusy.has(handle) || dmContextRefreshes >= 2) { if (dmContextRefreshes >= 2) toast("Public-context refresh is capped at two people per session."); return; }
  const owner = dmStore.ownerHandle;
  dmBusy.add(handle); dmContextRefreshes++; renderDock();
  try {
    const res = await send<{ ok?: boolean; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "search-v3", query: { type: "Latest", count: "10", query: `from:${handle}` }, intent: true });
    if (dmStore.ownerHandle !== owner) return;
    if (!res?.ok) { toast(res?.error === "no-twttr-config" ? "Add your RapidAPI key to refresh public context." : "Couldn't refresh public context."); return; }
    const post = parseTimelineTweets(res.data).filter((t) => t.author.toLowerCase() === handle && !t.isReply && t.text).sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))[0];
    if (!post) { toast(`No recent original post found for @${handle}.`); return; }
    dmStore = appendDmContext(dmStore, handle, "public_post", "observed", post.text, Date.now(), { postId: post.id, url: `https://x.com/${handle}/status/${post.id}` });
    persistDms();
  } finally { dmBusy.delete(handle); renderDock(); }
}

async function draftDmFor(candidate: DmCandidate, phase: DmPhase): Promise<void> {
  const owner = dmStore.ownerHandle;
  candidate = dmStore.candidates.find((c) => c.handle === candidate.handle) ?? candidate;
  const check = canDraftDm(candidate, phase, Date.now());
  if (!check.ok) { toast(check.reason || "Add more context before drafting."); return; }
  const sendGate = canMarkDmSend(dmStore, phase, Date.now()); if (!sendGate.ok) { toast(sendGate.reason || "Pause DMs for now."); return; }
  if (dmBusy.has(candidate.handle)) return;
  dmBusy.add(candidate.handle); renderDock();
  try {
    const product = xProducts.find((p) => p.name === candidate.productName);
    const resp = await send<{ text?: string; error?: string }>({ type: "DRAFT_DM", handle: candidate.handle, intent: candidate.intent, phase, goal: candidate.goal,
      recipient: { name: candidate.name, bio: candidate.bioSnapshot, followers: candidate.followers }, product,
      reasons: candidate.reasons, context: candidate.context.filter((x) => !x.removedAt), priorMessages: candidate.touches });
    if (dmStore.ownerHandle !== owner) return;
    if (resp?.error) { toast(`Couldn't draft: ${friendlyErr(resp.error)}.`); return; }
    if (resp?.text) { dmStore = updateDmCandidate(dmStore, candidate.handle, { draft: resp.text, draftPhase: phase }, Date.now()); persistDms(); }
  } finally { dmBusy.delete(candidate.handle); renderDock(); }
}

function markCurrentDmSent(handle: string): void {
  const candidate = dmStore.candidates.find((c) => c.handle === handle);
  if (!candidate) return;
  const text = candidate.draft?.trim(), phase = candidate.draftPhase;
  if (!text || !phase) return;
  const lifecycle = canDraftDm(candidate, phase, Date.now());
  if (!lifecycle.ok && !window.confirm(`${lifecycle.reason}\n\nIf you already sent it on X, record that fact anyway?`)) return;
  const dupe = findDmDuplicate(dmStore, text);
  if (dupe && !window.confirm(`This is too similar to a recent DM to @${dupe.handle}. Goobi recommends editing it.\n\nIf you already sent it on X, record it anyway?`)) return;
  const sendGate = canMarkDmSend(dmStore, phase, Date.now());
  if (!sendGate.ok && !window.confirm(`${sendGate.reason}\n\nIf you already sent it on X, record that fact anyway?`)) return;
  dmMutate(markDmSent(dmStore, candidate.handle, text, phase, Date.now()));
}

function saveDmContext(candidate: DmCandidate, kind: DmContextKind, asReply = false): void {
  const text = (dmContextDrafts.get(candidate.handle) || "").trim();
  if (!text) { toast("Paste a message or write a note first."); return; }
  dmStore = asReply ? markDmReplied(dmStore, candidate.handle, text, Date.now()) : appendDmContext(dmStore, candidate.handle, kind, "user", text, Date.now());
  dmContextDrafts.delete(candidate.handle); persistDms(); renderDock();
}

/** The ONLY measured-on-our-data factor: how our replies to this handle have actually done.
 *  Neutral (undefined → 1.0 in the ranker) for a new candidate — never imputed. */
function learnedMultForHandle(handle: string, agg: ReturnType<typeof aggregateAccounts>): number | undefined {
  const a = Object.entries(agg.accounts).find(([k]) => k.toLowerCase() === handle.toLowerCase())?.[1];
  if (!a) return undefined;
  if (a.score != null) return Math.min(1.15, Math.max(0.9, 0.9 + 0.25 * (a.score / (agg.muObs || 1)))); // measured (Tier-2, nOut>=4)
  if (a.nEff > 0) return Math.min(1.03, Math.max(0.97, 0.97 + 0.06 * (a.invest - agg.muInvest)));         // invest-only — near-inert, effort not payoff
  return undefined;
}

/** Add a suggested account to the tracked list — reuses the cached follower count (no fetch). */
function trackSuggestion(handle: string, followers: number): void {
  if (!myFollowers || excludeFromTargets(followers, myFollowers)) return; // re-check the gate on the cached snapshot
  const r = addTarget(targetStore, handle, followers, "auto", Date.now());
  if (r.error) { toast(r.error); return; }
  targetStore = { ...r.store, handle: targetStore.handle };
  if (!targetStore.handle) void myHandle().then((h) => { targetStore = { ...targetStore, handle: h }; persistTargets(); });
  persistTargets(); renderDock();
}

/** "your replies here…" — reuse the learning loop so the user sees which targets actually pay off. */
function targetStanding(handle: string, agg: ReturnType<typeof aggregateAccounts>): { text: string; cls: string } {
  const h = handle.toLowerCase();
  const a = Object.entries(agg.accounts).find(([k]) => k.toLowerCase() === h)?.[1];
  if (!a || a.replies === 0) return { text: "no replies here yet", cls: "tg-muted" };
  const back = a.backs ? ` · ↩ engaged back ×${a.backs}` : ""; // measured from your notifications (visit-dependent)
  if (a.score != null) {
    if (a.score > agg.muObs * 1.1) return { text: `✓ your replies here beat your average (${a.replies})${back}`, cls: "tg-good" };
    if (a.score < agg.muObs * 0.9) return { text: `your replies here trail your average (${a.replies})${back}`, cls: "tg-muted" };
    return { text: `your replies here are about average (${a.replies})${back}`, cls: "tg-muted" };
  }
  return { text: `${a.replies} ${a.replies === 1 ? "reply" : "replies"}${back} · still learning (${a.nOut}/4 measured)`, cls: "tg-muted" };
}

async function addTargetByHandle(raw: string): Promise<void> {
  if (targetAdding) return;
  const handle = raw.replace(/^@+/, "").trim();
  if (!handle) return;
  if (!myFollowers) { targetAddMsg = "Set your follower count in the Goobi panel first."; renderDock(); return; }
  targetAdding = true; targetAddMsg = `Checking @${handle}…`; renderDock();
  try {
    const res = await send<{ ok?: boolean; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "user", query: { username: handle }, intent: true });
    if (res?.error === "no-twttr-config") { targetAddMsg = "Add your RapidAPI key in the Goobi panel."; return; }
    const u = res?.ok ? parseUser(res.data) : null;
    if (!u || u.followers == null) { targetAddMsg = `Couldn't find @${handle}.`; return; }
    if (excludeFromTargets(u.followers, myFollowers)) { targetAddMsg = `@${handle} (${fmtCount(u.followers)}) is too big to reach from your size — aim for accounts up to ~${bandHiFor(myFollowers)}× you.`; return; }
    const r = addTarget(targetStore, handle, u.followers, "manual", Date.now());
    if (r.error) { targetAddMsg = r.error; return; }
    targetStore = { ...r.store, handle: targetStore.handle || (await myHandle()) }; // stamp the owner so the list can't bleed across accounts
    persistTargets(); targetAddMsg = "";
  } finally { targetAdding = false; renderDock(); }
}

/** Pin a truly massive account for direct Fresh Reach checks. This is deliberately separate from
 * practical Targets: it accepts accounts beyond the reach band, remains owner-scoped, and never
 * bypasses the post-level freshness, competition, risk, or contribution-quality gates. */
async function addFreshReachWatch(raw: string): Promise<void> {
  if (freshReachWatchAdding) return;
  const requested = normalizeWatchHandle(raw);
  if (!/^[a-z0-9_]{1,15}$/.test(requested)) { freshReachWatchMsg = "Enter a valid X @handle."; renderDock(); return; }
  if (!myFollowers) { freshReachWatchMsg = "Set your follower count in the Goobi panel first."; renderDock(); return; }
  const owner = normalizeWatchHandle(await myHandle()) || normalizeWatchHandle(getSelf());
  if (!owner) { freshReachWatchMsg = "Set your own X handle in the Goobi panel first."; renderDock(); return; }
  if (freshReachWatchStore.ownerHandle !== owner) freshReachWatchStore = { ownerHandle: owner, entries: [] };
  if (freshReachWatchStore.entries.some((entry) => entry.handle === requested)) { freshReachWatchMsg = `@${requested} is already pinned.`; renderDock(); return; }
  if (freshReachWatchStore.entries.length >= FRESH_REACH_WATCHLIST_MAX) { freshReachWatchMsg = `The Massive watchlist is capped at ${FRESH_REACH_WATCHLIST_MAX}; remove one first.`; renderDock(); return; }
  freshReachWatchAdding = true; freshReachWatchMsg = `Checking @${requested}…`; renderDock();
  try {
    const res = await send<{ ok?: boolean; status?: number; data?: unknown; error?: string }>({
      type: "TWTTR_GET", path: "user", query: { username: requested }, intent: true,
    });
    if (res?.error === "no-twttr-config") { freshReachWatchMsg = "Add your RapidAPI key in the Goobi panel."; return; }
    if (res?.error?.startsWith("budget-")) { freshReachWatchMsg = "The monthly X-data budget is nearly used; try again after it resets."; return; }
    if (!res?.ok) {
      freshReachWatchMsg = res?.status === 401 || res?.status === 403
        ? "This RapidAPI key is invalid or is not subscribed to twitter241. Fix the subscription, then try again."
        : res?.status === 429 ? "The provider is rate-limiting requests. Wait a moment, then try again."
          : `Couldn't look up @${requested}${res?.status ? ` (HTTP ${res.status})` : ""}.`;
      return;
    }
    const user = parseUser(res.data);
    const handle = normalizeWatchHandle(user?.handle || requested);
    if (!user || !/^[a-z0-9_]{1,15}$/.test(handle) || !user.followers) { freshReachWatchMsg = `Couldn't find @${requested}.`; return; }
    if (handle === owner) { freshReachWatchMsg = "Your own account cannot be added to the Massive watchlist."; return; }
    if (!isMassiveFreshReachAccount(user.followers, myFollowers)) {
      freshReachWatchMsg = `@${handle} (${fmtCount(user.followers)}) fits the practical range; add it under Targets instead.`;
      return;
    }
    freshReachWatchStore.entries.push({ handle, followers: user.followers, addedAt: Date.now() });
    freshReachWatchStore = normalizeFreshReachWatchStore(freshReachWatchStore, owner);
    authorReach.set(handle, { followers: user.followers, following: user.following, bio: user.bio, at: Date.now() });
    freshReachFailedAt.delete(handle);
    persistFreshReachWatchlist(); schedulePersistReach(); freshReachWatchMsg = "";
  } finally { freshReachWatchAdding = false; renderDock(); }
}

function removeFreshReachWatch(handle: string): void {
  const key = normalizeWatchHandle(handle);
  freshReachWatchStore = { ...freshReachWatchStore, entries: freshReachWatchStore.entries.filter((entry) => entry.handle !== key) };
  persistFreshReachWatchlist(); freshReachWatchMsg = `Removed @${key} from direct scans.`; renderDock();
}
async function ensureFreshReachWatchOwner(): Promise<void> {
  const owner = normalizeWatchHandle(await myHandle()) || normalizeWatchHandle(getSelf());
  const stored = await getLocal(CONFIG.X_FRESH_REACH_WATCHLIST_KEY);
  freshReachWatchStore = normalizeFreshReachWatchStore(stored, owner);
  freshReachWatchMsg = "";
  if (dockView === "targets") renderDock();
}
/** Reset the target list if the signed-in account changed mid-session (mirrors the learn store). */
async function ensureTargetOwner(): Promise<void> {
  if (invalidated) return;
  const ownH = await myHandle();
  if (ownH && targetStore.handle && targetStore.handle !== ownH) { targetStore = freshStore(ownH); persistTargets(); if (dockView === "targets") renderDock(); }
}

/** Pull the target's freshest ORIGINAL post (reuses the proven from:<handle> search). */
async function findTargetPost(handle: string, ambient = false): Promise<void> {
  if (targetBusy.has(handle)) return;
  targetBusy.add(handle); renderDock();
  try {
    // Ambient polls carry intent:false so conserve mode silently pauses them (the governor's
    // degrade ladder is the budget guard); an explicit user click stays intent:true.
    const res = await send<{ ok?: boolean; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "search-v3", query: { type: "Latest", count: "10", query: `from:${handle}` }, intent: !ambient });
    if (res?.ok) {
      freshReachFailedAt.delete(handle.toLowerCase());
      const originals = parseTimelineTweets(res.data)
        .filter((t) => !t.isReply && t.text && t.author?.toLowerCase() === handle.toLowerCase())
        .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
      observeOpportunityTweets(originals); // snapshot every returned original; newest may change between polls
      const newest = originals[0];
      targetPosts.set(handle, newest ? { id: newest.id, text: newest.text, postedAt: newest.postedAt, author: newest.author, replies: newest.replies, likes: newest.likes, reposts: newest.reposts, quotes: newest.quotes, views: newest.views } : { id: "", text: "", author: handle });
      if (!ambient) targetDrafts.delete(handle); // an explicit refresh invalidates the old draft; an ambient poll never touches the user's draft
      // TTL bookkeeping on the PERSISTED target — this is what makes remounts/second tabs free
      // (selectPollBatch skips anything polled within TARGET_POLL_TTL_MS).
      const tg = targetStore.targets.find((t) => t.handle.toLowerCase() === handle.toLowerCase());
      if (tg) { tg.lastPolledAt = Date.now(); if (newest?.id) tg.lastFreshPostId = newest.id; persistTargets(); }
    } else freshReachFailedAt.set(handle.toLowerCase(), Date.now());
  } finally { targetBusy.delete(handle); renderDock(); }
}

/** The ambient target poller (spike-verified 2026-07: the provider does NOT honor batched
 *  "from:a OR from:b" searches — one author's tweets come back — so this is the per-handle path).
 *  selectPollBatch enforces the budget invariant: ≤POLLS_PER_OPEN per kick, 12-min per-target TTL
 *  persisted on the target itself. Skips entirely when paused/locked/unconfigured; ambient calls
 *  degrade to silence in conserve mode via intent:false. */
let pollKickAt = 0;
async function pollTargets(): Promise<void> {
  if (paused || twttrUnconfigured || !targetStore.targets.length) return;
  if (currentReplyPace().level === "easeoff") return; // cooling down — don't dangle fresh targets
  if (Date.now() - pollKickAt < 60_000) return; // render-loop guard; the real gate is the per-target TTL
  pollKickAt = Date.now();
  for (const tg of selectPollBatch(targetStore.targets, Date.now())) {
    if (invalidated) return;
    const failedAt = freshReachFailedAt.get(tg.handle.toLowerCase());
    if (failedAt && Date.now() - failedAt < FRESH_REACH_FAILURE_BACKOFF_MS) continue;
    await findTargetPost(tg.handle, true); // sequential — the governor's token bucket stays smooth
  }
}

async function draftTargetReply(handle: string): Promise<void> {
  const post = targetPosts.get(handle);
  if (!post?.text || targetBusy.has(handle)) return;
  targetBusy.add(handle); goobiDrafting = true; refreshGoobi(); renderDock();
  try {
    const target = targetStore.targets.find((t) => t.handle.toLowerCase() === handle.toLowerCase());
    let opp = opps.get(post.id);
    if (!opp) {
      // Target cards used to bypass the content-fit scorer and all of the normal drafting context.
      // Score once, then promote the fetched post into the shared opportunity model so drafting,
      // reply logging, duplicate checks, and measured outcomes all see the same honest record.
      const scored = await send<{ scores?: ScoredPost[]; error?: string }>({
        type: "SCORE_POSTS", posts: [{ i: 0, author: post.author, text: post.text.slice(0, 400) }],
      });
      if (scored?.error === "no-key") { toast("Add your Anthropic key in the Goobi panel to score and draft replies."); return; }
      const s = scored?.scores?.[0];
      if (!s) { toast("Couldn't score that post before drafting — try again."); return; }
      const reason = (s.reason || "").split(/\s+/).slice(0, 6).join(" ");
      const category = catId(s.category);
      const products = category === "promote" && Array.isArray(s.products)
        ? s.products.map((n) => xProducts.find((p) => p.name === n)).filter((p): p is ProductItem => !!p).slice(0, 2)
        : undefined;
      const freshCandidate = pickFreshReachCandidates([{
        ...post, followers: target?.followers, isReply: false,
      }], myFollowers, Date.now(), replyLog.authors, 1)[0];
      const isFreshReach = freshReachContentEligible(s) && !!freshCandidate;
      const targetFreshEvidence: FreshReachEvidence | undefined = isFreshReach && freshCandidate ? {
        runId: `target.${Date.now().toString(36)}`, discoveredAt: Date.now(), observedAt: Date.now(),
        expiresAt: (post.postedAt ?? Date.now()) + FRESH_REACH_MAX_AGE_MS,
        repliesObserved: post.replies!, sizeMultiple: freshCandidate.sizeMultiple,
        accountSource: "tracked", accountPriority: 1,
        observedOpportunity: freshCandidate.opportunity, contentFit: s.score, kind: freshCandidate.kind,
        viewsObserved: post.views, engagementsObserved: freshCandidate.signals.engagements,
        viewsPerMinute: freshCandidate.signals.viewsPerMinute,
        engagementsPerMinute: freshCandidate.signals.engagementsPerMinute,
        distributionScore: freshCandidate.signals.distributionScore,
        openingScore: freshReachOpeningScore({ contentFit: s.score, observedOpportunity: freshCandidate.opportunity }),
      } : undefined;
      opp = {
        id: post.id, author: post.author, text: post.text.slice(0, 400), score: s.score,
        reason, category, products, anchor: s.anchor, replyMove: s.replyMove, replyBrief: s.replyBrief, risk: s.risk,
        postedAt: post.postedAt, likes: post.likes, replies: post.replies,
        reposts: post.reposts, quotes: post.quotes, views: post.views, followers: target?.followers,
        source: isFreshReach ? "fresh-reach" : "target", freshReach: targetFreshEvidence,
      };
      opps.set(post.id, opp);
      seen.set(post.id, { score: s.score, reason, category, products, anchor: s.anchor, replyMove: s.replyMove, replyBrief: s.replyBrief, risk: s.risk });
    }
    const angle = initialAngle(opp.category);
    const authorLine = [
      `@${opp.author}`,
      knownFollowers(opp) != null ? `~${fmtCount(knownFollowers(opp))} followers` : "",
      "a user selected target in the user's niche",
    ].filter(Boolean).join(" · ");
    const targetLiveFresh = currentFreshReach(opp);
    const opportunityLine = opp.source === "fresh-reach"
      ? targetLiveFresh
        ? `Goobi currently observes this tracked post as ${targetLiveFresh.ageMinutes} minutes old with ${opp.replies} replies. Write one self contained contribution for surrounding readers. Never mention targeting, timing, account size, Premium, a blue check, reach, or impressions.`
        : "This tracked post was originally a Fresh reach opening but has since cooled or filled. Do not imply urgency; draft only a contribution that remains specifically worthwhile."
      : "This is a user selected target account. The post is not inside the strict fresh reach window, so do not imply urgency or manufacture a reason to reply. Draft only a specific, self contained contribution.";
    const resp = await send<{ reply?: string; error?: string }>({
      type: "DRAFT_REPLY", author: post.author, text: post.text, angle,
      product: productContext(opp.products?.[0]), reason: opp.reason, category: opp.category, anchor: opp.anchor, replyBrief: opp.replyBrief,
      authorLine, opportunityLine,
    });
    if (resp?.error === "no-key") { toast("Add your Anthropic key in the Goobi panel to draft replies."); return; }
    if (resp?.reply) targetDrafts.set(handle, resp.reply); else toast("Couldn't draft a reply — try again.");
  } finally { targetBusy.delete(handle); goobiDrafting = false; refreshGoobi(); renderDock(); }
}

/* ---- Fresh Reach radar: discover larger accounts through governed Top + Latest searches ---- */
/** Cross-session persistence for the two coverage caches — implements the governor's stated v2.
 *  MERGE-into-stored (never overwrite: the long-session memory bound clears the in-memory maps,
 *  and a plain write would wipe the compounding history), prune past-TTL on both load and write,
 *  cap sizes. authorReach is PUBLIC author data (no owner stamp); heavyHitters is derived from
 *  the user's niche QUERY, so it's stamped with the niche and flushed when the niche changes. */
const REACH_PERSIST_MAX = 600, HEAVY_PERSIST_MAX = 200;
type ReachEntry = { followers?: number; following?: number; bio?: string; at: number };
function mergeHeavyHitterEntry(stored: HeavyHitterEntry | undefined, live: HeavyHitterEntry): HeavyHitterEntry {
  if (!stored) return live;
  const ids = [...new Set([...(stored.openingPostIds ?? []), ...(live.openingPostIds ?? [])])].slice(-20);
  const liveIsNewer = (live.lastSeenAt ?? live.at ?? 0) >= (stored.lastSeenAt ?? stored.at ?? 0);
  const shortlist = (live.shortlistAt ?? 0) >= (stored.shortlistAt ?? 0) ? live : stored;
  return {
    ...stored, ...live,
    followers: liveIsNewer ? live.followers : stored.followers,
    engRate: liveIsNewer ? live.engRate : stored.engRate,
    n: Math.max(stored.n, live.n),
    at: Math.max(stored.at ?? 0, live.at ?? 0) || undefined,
    discoveredAt: Math.min(stored.discoveredAt ?? Infinity, live.discoveredAt ?? Infinity) === Infinity ? undefined : Math.min(stored.discoveredAt ?? Infinity, live.discoveredAt ?? Infinity),
    lastSeenAt: Math.max(stored.lastSeenAt ?? 0, live.lastSeenAt ?? 0) || undefined,
    lastCheckedAt: Math.max(stored.lastCheckedAt ?? 0, live.lastCheckedAt ?? 0) || undefined,
    checks: Math.max(stored.checks ?? 0, live.checks ?? 0) || undefined,
    openingPostIds: ids.length ? ids : undefined,
    strongOpenings: Math.max(ids.length, stored.strongOpenings ?? 0, live.strongOpenings ?? 0) || undefined,
    distributionScore: Math.max(stored.distributionScore ?? 0, live.distributionScore ?? 0) || undefined,
    viewRate: Math.max(stored.viewRate ?? 0, live.viewRate ?? 0) || undefined,
    peakViews: Math.max(stored.peakViews ?? 0, live.peakViews ?? 0) || undefined,
    peakEngagements: Math.max(stored.peakEngagements ?? 0, live.peakEngagements ?? 0) || undefined,
    source: stored.source === "top" || live.source === "top" ? "top" : (live.source ?? stored.source),
    shortlisted: shortlist.shortlisted,
    replyViewOutcomes: shortlist.replyViewOutcomes,
    replyViewScore: shortlist.replyViewScore,
    bestReplyViews: shortlist.bestReplyViews,
    shortlistAt: shortlist.shortlistAt,
  };
}
async function persistReachCaches(): Promise<void> {
  // Two-tab note: this read-modify-write can drop the OTHER tab's increments (both merge from the
  // same stored snapshot; last writer wins). Accepted — every entry is a TTL'd, refetchable cache.
  const now = Date.now();
  // authorReach: merge fresh, real entries (pending/failed are session-only states, never persisted)
  const storedR = (await getLocal(CONFIG.X_AUTHOR_REACH_KEY)) as Record<string, ReachEntry> | undefined;
  const mergedR: Record<string, ReachEntry> = {};
  for (const [k, v] of Object.entries(storedR ?? {})) if (v && now - v.at < AUTHOR_REACH_TTL_MS) mergedR[k] = v;
  for (const [k, v] of authorReach) if (!v.pending && !v.failed && now - v.at < AUTHOR_REACH_TTL_MS) mergedR[k] = { followers: v.followers, following: v.following, bio: v.bio, at: v.at };
  const rKeys = Object.keys(mergedR);
  if (rKeys.length > REACH_PERSIST_MAX) for (const k of rKeys.sort((a, b) => mergedR[a].at - mergedR[b].at).slice(0, rKeys.length - REACH_PERSIST_MAX)) delete mergedR[k];
  safeSet({ [CONFIG.X_AUTHOR_REACH_KEY]: mergedR });
  // heavyHitters: same merge, stamped with the niche that produced it
  const niche = xNiche.trim();
  if (niche) {
    const storedH = (await getLocal(CONFIG.X_HEAVY_HITTERS_KEY)) as HeavyHitterStore | undefined;
    const mergedH: Record<string, HeavyHitterEntry> = {};
    if (storedH?.niche === niche) for (const [k, v] of Object.entries(storedH.entries ?? {})) if (v?.at && now - v.at < HEAVY_HITTER_TTL_MS) mergedH[k] = v;
    for (const [k, v] of heavyHitters) if (v.at && now - v.at < HEAVY_HITTER_TTL_MS) mergedH[k] = mergeHeavyHitterEntry(mergedH[k], v);
    const hKeys = Object.keys(mergedH);
    if (hKeys.length > HEAVY_PERSIST_MAX) for (const k of hKeys.sort((a, b) => (mergedH[a].at ?? 0) - (mergedH[b].at ?? 0)).slice(0, hKeys.length - HEAVY_PERSIST_MAX)) delete mergedH[k];
    safeSet({ [CONFIG.X_HEAVY_HITTERS_KEY]: { niche, entries: mergedH } });
  }
}
let persistReachTimer: number | undefined;
function schedulePersistReach(): void {
  if (persistReachTimer) clearTimeout(persistReachTimer);
  persistReachTimer = setTimeout(() => { persistReachTimer = undefined; void persistReachCaches(); }, 2000) as unknown as number;
}

let heavyHitters = new Map<string, HeavyHitterEntry>(); // persistent Fresh Reach radar: size, observed engagement, checks, and strong openings
let heavyLoading = false;
let showAllFreshRadar = false;
interface HeavyRefreshResult { discovered: number; total: number; budgetLimited: boolean; status?: number; error?: string; }
const heavyFlights = new Map<string, Promise<HeavyRefreshResult>>();
let heavyTried = false; // auto-discover once per session on entering Targets

/** Fold the max-10 settled reply-view keep-list into the durable radar. The reply ledger remains
 * the source of truth; these copied fields only keep API rotation/check timestamps useful. */
function syncFreshReachShortlistIntoRadar(): FreshReachShortlistAccount[] {
  const shortlist = currentFreshReachShortlist();
  const desired = new Map(shortlist.map((winner) => [winner.handle, winner]));
  let changed = false;
  for (const [handle, entry] of heavyHitters) {
    const winner = desired.get(handle);
    if (!winner) {
      if (entry.shortlisted || entry.replyViewOutcomes != null || entry.replyViewScore != null || entry.bestReplyViews != null || entry.shortlistAt != null) {
        changed = true;
        delete entry.shortlisted;
        delete entry.replyViewOutcomes;
        delete entry.replyViewScore;
        delete entry.bestReplyViews;
        delete entry.shortlistAt;
      }
      continue;
    }
    desired.delete(handle);
    if (!entry.shortlisted || entry.followers !== winner.followers || entry.replyViewOutcomes !== winner.outcomes
      || entry.replyViewScore !== winner.replyViewScore || entry.bestReplyViews !== winner.bestReplyViews || entry.shortlistAt !== winner.lastOutcomeAt) changed = true;
    heavyHitters.set(handle, {
      ...entry,
      followers: winner.followers,
      at: Math.max(entry.at ?? 0, winner.lastOutcomeAt),
      discoveredAt: entry.discoveredAt ?? winner.lastOutcomeAt,
      shortlisted: true,
      replyViewOutcomes: winner.outcomes,
      replyViewScore: winner.replyViewScore,
      bestReplyViews: winner.bestReplyViews,
      shortlistAt: winner.lastOutcomeAt,
    });
    authorReach.set(winner.handle, { ...(authorReach.get(winner.handle) ?? { at: winner.lastOutcomeAt }), followers: winner.followers, at: Date.now() });
  }
  for (const winner of desired.values()) {
    if (!winner.followers) continue;
    changed = true;
    heavyHitters.set(winner.handle, {
      followers: winner.followers,
      engRate: 0,
      n: 0,
      at: winner.lastOutcomeAt,
      discoveredAt: winner.lastOutcomeAt,
      shortlisted: true,
      replyViewOutcomes: winner.outcomes,
      replyViewScore: winner.replyViewScore,
      bestReplyViews: winner.bestReplyViews,
      shortlistAt: winner.lastOutcomeAt,
    });
    authorReach.set(winner.handle, { followers: winner.followers, at: Date.now() });
  }
  if (changed) schedulePersistReach();
  return shortlist;
}

/** Fold niche-search authors into the persistent radar. Top and Latest are discovery evidence only;
 * every individual post still has to pass the strict live/content gates before it becomes a reply. */
function captureFreshRadarTweets(tweets: readonly TwttrTweet[], source: "top" | "latest"): number {
  const now = Date.now();
  const before = heavyHitters.size;
  const grouped = new Map<string, { followers: number; rates: number[]; viewRates: number[]; distribution: number[]; views: number[]; engagements: number[] }>();
  for (const tweet of tweets) {
    if (tweet.isReply || !tweet.author || !tweet.followers || tweet.followers < Math.max(2, myFollowers * 2)) continue;
    if (!tweet.text || looksLikeRT(tweet.text) || !isEnglish(tweet.text, tweet.lang) || isBait(tweet.text)) continue;
    const handle = tweet.author.toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(handle) || handle === selfHandle) continue;
    const signals = freshReachPostSignals(tweet, now);
    const engagementRate = signals.engagementRate ?? 0;
    const group = grouped.get(handle) ?? { followers: tweet.followers, rates: [], viewRates: [], distribution: [], views: [], engagements: [] };
    group.followers = tweet.followers;
    group.rates.push(engagementRate);
    if (signals.viewRate != null) group.viewRates.push(signals.viewRate);
    group.distribution.push(signals.distributionScore);
    if (tweet.views != null) group.views.push(tweet.views);
    if (signals.engagements != null) group.engagements.push(signals.engagements);
    grouped.set(handle, group);
  }
  const robust = (values: number[]): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    return 0.65 * sorted[sorted.length - 1] + 0.35 * median;
  };
  for (const [handle, group] of grouped) {
    const previous = heavyHitters.get(handle);
    const observedRate = robust(group.rates);
    const observedDistribution = robust(group.distribution);
    const observedViewRate = robust(group.viewRates);
    heavyHitters.set(handle, {
      ...previous,
      followers: group.followers,
      engRate: source === "top" ? observedRate : (previous?.engRate ?? observedRate),
      distributionScore: Math.max(previous?.distributionScore ?? 0, observedDistribution),
      viewRate: Math.max(previous?.viewRate ?? 0, observedViewRate),
      peakViews: Math.max(previous?.peakViews ?? 0, ...group.views),
      peakEngagements: Math.max(previous?.peakEngagements ?? 0, ...group.engagements),
      n: source === "top" ? group.rates.length : (previous?.n ?? group.rates.length),
      at: now,
      discoveredAt: previous?.discoveredAt ?? now,
      lastSeenAt: now,
      source: previous?.source === "top" ? "top" : source,
    });
    authorReach.set(handle, { ...(authorReach.get(handle) ?? { at: now }), followers: group.followers, at: now });
  }
  if (grouped.size) schedulePersistReach();
  return heavyHitters.size - before;
}
/** Top search supplies account-discovery evidence and normalized observed distribution. A manual
 * Fresh hunt uses both the focused niche query and one rotating exploration query; the governor
 * still owns caching and monthly-budget enforcement for every request. */
function findHeavyHitters(silent = false, queryOverride?: string | readonly string[]): Promise<HeavyRefreshResult> {
  const niche = xNiche.trim();
  if (!niche) return Promise.resolve({ discovered: 0, total: heavyHitters.size, budgetLimited: false });
  const requested = Array.isArray(queryOverride) ? queryOverride : [queryOverride || nicheSearchQuery(niche)];
  const queries = [...new Set(requested.map((query) => query.trim()).filter(Boolean))].slice(0, 2);
  const flightKey = queries.join("\n");
  const existing = heavyFlights.get(flightKey);
  if (existing) return existing;
  heavyLoading = true; if (!silent) renderDock();
  let flight!: Promise<HeavyRefreshResult>;
  flight = (async () => { try {
    // LIVE-VERIFIED 2026-07: the provider's Top tab REJECTS search operators (-filter:/lang: →
    // zero results) while honoring the OR-topic form — so the query is operator-FREE and the
    // quality filtering happens entirely in the client-side screen below (isBait/RT/lang), which
    // was already in place. (The operator suffix added in the "hardening" pass silently killed
    // this feature: 0 parsed → empty pool, no error.)
    const results = await Promise.all(queries.map((query) => send<{ ok?: boolean; status?: number; data?: unknown; error?: string }>({
      type: "TWTTR_GET", path: "search-v3", query: { type: "Top", count: "40", query }, intent: true,
    })));
    const successful = results.filter((result) => result?.ok);
    const firstFailure = results.find((result) => !result?.ok);
    const firstError = firstFailure?.error;
    if (!successful.length) {
      if (!silent) {
        if (firstError === "no-twttr-config") toast("Add your RapidAPI key in the Goobi panel to expand the Fresh Reach radar.");
        else if (firstError?.startsWith("budget-")) toast("Local/provider X-data safety budget nearly used — check RapidAPI for the billing-cycle reset.");
        else if ([401, 402, 403].includes(firstFailure?.status ?? 0)) toast(`Fresh Reach radar blocked (HTTP ${firstFailure?.status}) — the key is invalid or not subscribed to twitter241.`);
        else if (firstFailure?.status === 429 || firstError?.startsWith("provider-backoff")) toast("Fresh Reach radar is waiting for the provider rate-limit/backoff window to reset.");
        else toast("Couldn't expand the Fresh Reach radar — try again.");
      }
      return {
        discovered: 0, total: heavyHitters.size,
        budgetLimited: !!firstError?.startsWith("budget-"),
        status: firstFailure?.status, error: firstError,
      };
    }
    const now = Date.now();
    for (const [handle, value] of heavyHitters) if (!value.at || now - value.at >= HEAVY_HITTER_TTL_MS) heavyHitters.delete(handle);
    const before = heavyHitters.size;
    captureFreshRadarTweets(results.flatMap((result) => result?.ok ? parseTimelineTweets(result.data) : []), "top");
    return {
      discovered: Math.max(0, heavyHitters.size - before), total: heavyHitters.size,
      budgetLimited: results.some((result) => result?.error?.startsWith("budget-")),
    };
  } finally {
    if (heavyFlights.get(flightKey) === flight) heavyFlights.delete(flightKey);
    heavyLoading = heavyFlights.size > 0;
    if (!silent) renderDock();
  } })();
  heavyFlights.set(flightKey, flight);
  return flight;
}

function buildTargets(): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "ideas"; // reuse the flex-scroll container
  const head = document.createElement("div"); head.className = "ideahead";
  if (!myFollowers) {
    const gate = document.createElement("div"); gate.className = "idea-gate";
    const t = document.createElement("div"); t.className = "ideagate-t"; t.textContent = "Set your follower count first";
    const p = document.createElement("div"); p.className = "ideasub"; p.textContent = "Targeting needs your size so it only suggests accounts you can actually reach. Add it in the Goobi side panel."; p.style.marginTop = "8px";
    gate.append(t, p); head.append(gate); wrap.append(head);
    return wrap;
  }
  const locked = currentReplyPace().level === "easeoff"; // same adaptive pace source as the dock chip
  const shortlist = syncFreshReachShortlistIntoRadar(); // idempotent; also drops expired 30-day winners
  const sub = document.createElement("div"); sub.className = "ideasub";
  sub.textContent = "Fresh Reach uses Latest plus two Top discovery lenses, then checks up to twelve due accounts for genuinely early originals. Four rotating lanes go to massive accounts you pin; measured winners and new evidence-backed accounts keep separate coverage. Every post still needs a specific contribution.";
  head.append(sub);
  const watchHead = document.createElement("div"); watchHead.className = "tg-radar-head";
  const watchCopy = document.createElement("div");
  const watchTitle = document.createElement("div"); watchTitle.className = "tg-sughead"; watchTitle.textContent = `Massive watchlist · ${freshReachWatchStore.entries.length}/${FRESH_REACH_WATCHLIST_MAX}`;
  const watchMeta = document.createElement("div"); watchMeta.className = "tg-foot"; watchMeta.textContent = "Private pins · up to four due accounts checked per hunt · relevance still required";
  watchCopy.append(watchTitle, watchMeta);
  const scanWatch = document.createElement("button"); scanWatch.className = "scanb tg-track"; scanWatch.textContent = findingSpots ? "Scanning…" : "Scan pinned";
  scanWatch.disabled = findingSpots || locked || !freshReachWatchStore.entries.length; scanWatch.onclick = () => void findSpots("fresh-reach");
  watchHead.append(watchCopy, scanWatch); head.append(watchHead);
  const watchAdd = document.createElement("div"); watchAdd.className = "tg-add";
  const watchInput = document.createElement("input"); watchInput.className = "idea-steerin"; watchInput.placeholder = "@massive account to scan directly";
  const watchButton = document.createElement("button"); watchButton.className = "scanb"; watchButton.textContent = freshReachWatchAdding ? "…" : "Pin"; watchButton.disabled = freshReachWatchAdding;
  const doWatchAdd = () => { const value = watchInput.value; watchInput.value = ""; void addFreshReachWatch(value); };
  watchButton.onclick = doWatchAdd; watchInput.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); doWatchAdd(); } };
  watchAdd.append(watchInput, watchButton); head.append(watchAdd);
  if (freshReachWatchMsg) { const message = document.createElement("div"); message.className = "ideasub"; message.textContent = freshReachWatchMsg; head.append(message); }
  for (const entry of freshReachWatchStore.entries) {
    const row = document.createElement("div"); row.className = "tg-sug tg-radar-row";
    row.append(avatarChip(entry.handle, lastSeenFor(entry.handle)));
    const mid = document.createElement("div"); mid.style.flex = "1"; mid.style.minWidth = "0";
    const link = document.createElement("a") as HTMLAnchorElement; link.className = "ins-h"; link.textContent = `@${entry.handle}`; link.href = `https://x.com/${entry.handle}`; link.target = "_blank"; link.rel = "noopener"; link.style.textDecoration = "none";
    const meta = document.createElement("div"); meta.className = "ins-meta";
    const facts = [`${fmtCount(entry.followers)} followers`, entry.lastCheckedAt ? `checked ${fmtAge(entry.lastCheckedAt)}` : "waiting for first scan"];
    if (entry.strongOpenings) facts.push(`${entry.strongOpenings} strong ${entry.strongOpenings === 1 ? "opening" : "openings"}`);
    meta.textContent = facts.join(" · "); mid.append(link, meta);
    const remove = document.createElement("button"); remove.className = "lk"; remove.textContent = "Remove"; remove.title = `Stop direct scans for @${entry.handle}`; remove.onclick = () => removeFreshReachWatch(entry.handle);
    row.append(mid, remove); head.append(row);
  }
  const targetLabel = document.createElement("div"); targetLabel.className = "tg-sughead"; targetLabel.textContent = "Practical Targets"; head.append(targetLabel);
  const addRow = document.createElement("div"); addRow.className = "tg-add";
  const inp = document.createElement("input"); inp.className = "idea-steerin"; inp.placeholder = "@handle to track";
  const addB = document.createElement("button"); addB.className = "scanb"; addB.textContent = targetAdding ? "…" : "Track"; addB.disabled = targetAdding;
  const doAdd = () => { const v = inp.value; inp.value = ""; void addTargetByHandle(v); };
  addB.onclick = doAdd; inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } };
  addRow.append(inp, addB); head.append(addRow);
  if (targetAddMsg) { const m = document.createElement("div"); m.className = "ideasub"; m.textContent = targetAddMsg; head.append(m); }
  // Actively expand the saved Fresh Reach radar (a governed rotating Top search). Auto-runs once per session.
  const hhB = document.createElement("button"); hhB.className = "scanb tg-hh"; hhB.disabled = heavyLoading;
  hhB.textContent = heavyLoading ? "⚡ Expanding radar…" : heavyHitters.size ? "⚡ Find more accounts" : "⚡ Build Fresh Reach radar";
  hhB.onclick = () => void findHeavyHitters(false, nextFreshReachExploreQuery(xNiche));
  head.append(hhB);
  const hasDiscoveredRadar = [...heavyHitters.values()].some((entry) => entry.source === "top" || entry.source === "latest");
  if (xNiche.trim() && !hasDiscoveredRadar && !heavyLoading && !heavyTried) { heavyTried = true; void findHeavyHitters(); }
  wrap.append(head);

  const now = Date.now();
  const agg = aggregateAccounts(replyLog.sent, now); // one pass → reused for suggestions + every target's standing
  const body = document.createElement("div"); body.className = "dl";
  if (locked) { const l = document.createElement("div"); l.className = "tg-warn"; l.style.margin = "0 0 4px"; l.textContent = "Adaptive pace pressure is high — targeting pauses while it decays. Use Reset local pace if Goobi's session baseline no longer reflects what you're doing; it does not reset X."; body.append(l); }

  const freshMeasured = replyLog.sent.filter((record) => record.source === "fresh-reach");
  const apiMatchedRecords = freshMeasured.filter((record) => record.confirmation === "rapidapi" || record.outcome?.tweetId);
  const viewMatchedRecords = apiMatchedRecords.filter((record) => record.outcome?.views != null);
  const settledViewRecords = viewMatchedRecords.filter((record) => record.outcome?.frozen === true);
  const measurement = document.createElement("div"); measurement.className = "tg-foot"; measurement.style.margin = "4px 0 10px";
  measurement.textContent = `Fresh measurement · ${freshMeasured.length} logged → ${apiMatchedRecords.length} API matched → ${viewMatchedRecords.length} with views → ${settledViewRecords.length} settled → ${shortlist.length} accounts kept`;
  measurement.title = "The keep-list uses only settled Fresh Reach replies that RapidAPI matched to an actual reply tweet and for which X reported views. A reply recorded after its opening expired cannot teach the winner lane.";
  body.append(measurement);

  if (shortlist.length) {
    const keepHead = document.createElement("div"); keepHead.className = "tg-radar-head";
    const keepCopy = document.createElement("div");
    const keepTitle = document.createElement("div"); keepTitle.className = "tg-sughead"; keepTitle.textContent = `Massive account keep-list · ${shortlist.length}/10`;
    const keepMeta = document.createElement("div"); keepMeta.className = "tg-foot"; keepMeta.textContent = "Settled X-reported views on your actual Fresh Reach replies · winner lane checked first";
    keepCopy.append(keepTitle, keepMeta);
    const scanKeep = document.createElement("button"); scanKeep.className = "scanb tg-track"; scanKeep.textContent = findingSpots ? "Scanning…" : "Scan winners";
    scanKeep.disabled = findingSpots || locked; scanKeep.onclick = () => void findSpots("fresh-reach");
    keepHead.append(keepCopy, scanKeep); body.append(keepHead);
    for (const winner of shortlist) {
      const row = document.createElement("div"); row.className = "tg-sug tg-radar-row";
      row.append(avatarChip(winner.handle, lastSeenFor(winner.handle)));
      const mid = document.createElement("div"); mid.style.flex = "1"; mid.style.minWidth = "0";
      const link = document.createElement("a") as HTMLAnchorElement; link.className = "ins-h"; link.textContent = `@${winner.handle}`; link.href = `https://x.com/${winner.handle}`; link.target = "_blank"; link.rel = "noopener"; link.style.textDecoration = "none"; mid.append(link);
      const meta = document.createElement("div"); meta.className = "ins-meta";
      meta.textContent = `${fmtCount(winner.followers)} followers · ~${fmtCount(winner.averageReplyViews)} reply views avg · best ${fmtCount(winner.bestReplyViews)} · ${winner.outcomes} settled · ${winner.confidence}`;
      meta.title = "Views are measured on your reply tweet through RapidAPI after the outcome settles. This is correlation with the account/thread, not proof that the account caused those views.";
      mid.append(meta); row.append(mid); body.append(row);
    }
  }

  const radarAccounts = [...heavyHitters.entries()]
    .filter(([, entry]) => !entry.shortlisted && entry.at && now - entry.at < HEAVY_HITTER_TTL_MS)
    .sort((a, b) => {
      const as = a[1].shortlisted ? 1 : 0, bs = b[1].shortlisted ? 1 : 0;
      const ay = (a[1].strongOpenings ?? 0) / Math.max(1, a[1].checks ?? 0);
      const by = (b[1].strongOpenings ?? 0) / Math.max(1, b[1].checks ?? 0);
      return bs - as || (b[1].replyViewScore ?? 0) - (a[1].replyViewScore ?? 0)
        || by - ay || (b[1].strongOpenings ?? 0) - (a[1].strongOpenings ?? 0)
        || (decayFreshReachEvidence(b[1].distributionScore, b[1].lastSeenAt ?? b[1].discoveredAt, now) ?? 0)
          - (decayFreshReachEvidence(a[1].distributionScore, a[1].lastSeenAt ?? a[1].discoveredAt, now) ?? 0)
        || b[1].engRate - a[1].engRate || b[1].followers - a[1].followers;
    });
  if (radarAccounts.length) {
    const radarHead = document.createElement("div"); radarHead.className = "tg-radar-head";
    const radarCopy = document.createElement("div");
    const radarTitle = document.createElement("div"); radarTitle.className = "tg-sughead"; radarTitle.textContent = `Fresh Reach radar · ${radarAccounts.length} saved`;
    const radarMeta = document.createElement("div"); radarMeta.className = "tg-foot";
    const massiveN = radarAccounts.filter(([, entry]) => isMassiveFreshReachAccount(entry.followers, myFollowers)).length;
    radarMeta.textContent = `${massiveN} massive · remembered for 30 days · measured winners plus new exploration choose the next twelve checks`;
    radarCopy.append(radarTitle, radarMeta);
    const scanRadar = document.createElement("button"); scanRadar.className = "scanb tg-track"; scanRadar.textContent = findingSpots ? "Scanning…" : "Scan + expand";
    scanRadar.disabled = findingSpots || locked; scanRadar.onclick = () => void findSpots("fresh-reach");
    radarHead.append(radarCopy, scanRadar); body.append(radarHead);
    for (const [handle, entry] of radarAccounts.slice(0, showAllFreshRadar ? radarAccounts.length : 12)) {
      const row = document.createElement("div"); row.className = "tg-sug tg-radar-row";
      row.append(avatarChip(handle, lastSeenFor(handle)));
      const mid = document.createElement("div"); mid.style.flex = "1"; mid.style.minWidth = "0";
      const link = document.createElement("a") as HTMLAnchorElement; link.className = "ins-h"; link.textContent = `@${handle}`; link.href = `https://x.com/${handle}`; link.target = "_blank"; link.rel = "noopener"; link.style.textDecoration = "none"; mid.append(link);
      const meta = document.createElement("div"); meta.className = "ins-meta";
      const facts = [`${fmtCount(entry.followers)} followers`, isMassiveFreshReachAccount(entry.followers, myFollowers) ? "massive exploration" : "practical reach"];
      if ((decayFreshReachEvidence(entry.distributionScore, entry.lastSeenAt ?? entry.discoveredAt, now) ?? 0) >= 0.58) facts.push("recent breakout distribution");
      if (entry.peakViews != null) facts.push(`peak observed ${fmtCount(entry.peakViews)} views`);
      if (entry.strongOpenings) facts.push(`${entry.strongOpenings} strong ${entry.strongOpenings === 1 ? "opening" : "openings"}`);
      if (entry.lastCheckedAt) facts.push(`checked ${fmtAge(entry.lastCheckedAt)}`);
      meta.textContent = facts.join(" · "); mid.append(meta); row.append(mid); body.append(row);
    }
    if (radarAccounts.length > 12) {
      const more = document.createElement("button"); more.className = "lk";
      more.textContent = showAllFreshRadar ? "Show strongest 12" : `Show all ${radarAccounts.length} saved accounts`;
      more.title = showAllFreshRadar ? "Collapse the radar list" : `${radarAccounts.length - 12} more accounts remain in automatic scan rotation even while hidden`;
      more.onclick = () => { showAllFreshRadar = !showAllFreshRadar; renderDock(); };
      body.append(more);
    }
  }

  // Suggested for you — FREE: the in-niche authors your last "Find spots" search already cached in
  // authorReach (followers only at Tier A), gated to the reach sweet-spot, ranked by suggestionScore.
  const tracked = new Set(targetStore.targets.map((t) => t.handle.toLowerCase()));
  const cands: SuggestionInput[] = [];
  for (const [handle, r] of authorReach) {
    const f = r.followers; if (f == null) continue;
    const hl = handle.toLowerCase();
    if (hl === selfHandle || tracked.has(hl)) continue;
    if (excludeFromTargets(f, myFollowers) || !inReachBand(f, myFollowers)) continue;
    const ratio = r.following != null && f > 0 ? r.following / f : undefined;
    cands.push({ handle, followers: f, following: r.following, bioTier: r.bio ? builderTier(r.bio, xNiche, ratio) : undefined, engRate: heavyHitters.get(hl)?.engRate, learnedMult: learnedMultForHandle(handle, agg) });
  }
  // Tier-B enrichment: fill following + bio for the strongest few candidates (cheap /user, capped at
  // REACH_CAP + governed via maybeFetchReach, which re-renders on completion) → openness + niche light up.
  for (const c of cands.filter((x) => x.following == null).sort((a, b) => b.followers - a.followers).slice(0, 8)) maybeFetchReach(c.handle);
  const suggestions = rankSuggestions(cands, myFollowers, dismissedSuggestions, 5);
  if (suggestions.length) {
    const sh = document.createElement("div"); sh.className = "tg-sughead"; sh.textContent = "Suggested for you"; body.append(sh);
    const by = document.createElement("div"); by.className = "tg-foot"; by.style.margin = "0 0 6px"; by.textContent = "Practical-size accounts you may want to track continuously. Massive accounts stay in the automatic Fresh Reach radar instead of the ambient Target poller."; body.append(by);
    for (const s of suggestions) {
      const sc = document.createElement("div"); sc.className = "tg-sug";
      sc.append(avatarChip(s.handle, lastSeenFor(s.handle)));
      const mid = document.createElement("div"); mid.style.flex = "1"; mid.style.minWidth = "0";
      const h = document.createElement("a") as HTMLAnchorElement; h.className = "ins-h"; h.textContent = "@" + s.handle; h.href = `https://x.com/${s.handle}`; h.target = "_blank"; h.rel = "noopener"; h.style.textDecoration = "none"; mid.append(h);
      const why = document.createElement("div"); why.className = "ins-meta"; why.textContent = suggestionReason(s, myFollowers); mid.append(why);
      sc.append(mid);
      const track = document.createElement("button"); track.className = "scanb tg-track"; track.textContent = "+ Track"; track.disabled = locked; track.onclick = () => trackSuggestion(s.handle, s.followers); sc.append(track);
      const dis = document.createElement("button"); dis.className = "tg-x"; dis.textContent = "×"; dis.title = "Not interested"; dis.onclick = () => { dismissedSuggestions.add(s.handle.toLowerCase()); renderDock(); }; sc.append(dis);
      body.append(sc);
    }
  }

  if (!targetStore.targets.length) {
    const e = document.createElement("div"); e.className = "idea-empty";
    e.textContent = suggestions.length ? "Track a practical suggestion above, or let Fresh Reach keep scanning the saved radar automatically." : "Add a practical target by @handle, or expand the Fresh Reach radar to discover larger accounts automatically.";
    body.append(e);
  }
  if (!locked) void pollTargets(); // ambient freshness — ≤5 budgeted polls, per-target 12-min TTL, conserve-mode-aware
  // Live posts float to the top: the whole point is catching the early window without clicking.
  const targetSortNow = Date.now();
  const trackedSorted = [...targetStore.targets].sort((a, b) => {
    const pa = targetPosts.get(a.handle), pb = targetPosts.get(b.handle);
    const la = pa?.postedAt && freshnessLabel(pa.postedAt, targetSortNow)?.live ? 1 : 0;
    const lb = pb?.postedAt && freshnessLabel(pb.postedAt, targetSortNow)?.live ? 1 : 0;
    if (la !== lb) return lb - la;
    const ta = adjustedTargetTime(pa?.postedAt, pa ? opportunityMomentum(pa.id, targetSortNow) : undefined);
    const tb = adjustedTargetTime(pb?.postedAt, pb ? opportunityMomentum(pb.id, targetSortNow) : undefined);
    return tb - ta || (pb?.postedAt ?? 0) - (pa?.postedAt ?? 0) || a.handle.localeCompare(b.handle);
  });
  for (const tg of trackedSorted) {
    const c = document.createElement("div"); c.className = "tg-card";
    const top = document.createElement("div"); top.className = "tg-top";
    top.append(avatarChip(tg.handle, lastSeenFor(tg.handle)));
    const mid = document.createElement("div"); mid.style.flex = "1"; mid.style.minWidth = "0";
    const h = document.createElement("a") as HTMLAnchorElement; h.className = "ins-h"; h.textContent = "@" + tg.handle; h.href = `https://x.com/${tg.handle}`; h.target = "_blank"; h.rel = "noopener"; h.style.textDecoration = "none";
    mid.append(h);
    const meta = document.createElement("div"); meta.className = "ins-meta";
    const bits: string[] = [];
    if (tg.followers) bits.push(`${fmtCount(tg.followers)} followers`);
    const rl = reachMultipleLabel(tg.followers, myFollowers); if (rl) bits.push(rl);
    if (inReachBand(tg.followers, myFollowers)) bits.push("in reach");
    meta.textContent = bits.join(" · ");
    mid.append(meta); top.append(mid);
    const rm = document.createElement("button"); rm.className = "tg-x"; rm.textContent = "×"; rm.title = "Stop tracking";
    rm.onclick = () => { targetStore = removeTarget(targetStore, tg.handle); targetPosts.delete(tg.handle); targetDrafts.delete(tg.handle); persistTargets(); renderDock(); };
    top.append(rm); c.append(top);
    const st = targetStanding(tg.handle, agg); const stEl = document.createElement("div"); stEl.className = `tg-stand ${st.cls}`; stEl.textContent = st.text; c.append(stEl);
    const planDmB = document.createElement("button"); planDmB.className = "tg-find dm-from-target"; planDmB.textContent = "Plan a DM"; planDmB.title = "Keep this target and add a separate, draft-only private conversation plan."; planDmB.onclick = () => planDmFromTarget(tg.handle); c.append(planDmB);

    const busy = targetBusy.has(tg.handle);
    const post = targetPosts.get(tg.handle);
    if (!post) {
      const find = document.createElement("button"); find.className = "tg-find"; find.textContent = busy ? "Looking…" : "Find latest original →"; find.disabled = busy || locked; find.onclick = () => void findTargetPost(tg.handle); c.append(find);
    } else if (!post.text) {
      const none = document.createElement("div"); none.className = "ins-meta"; none.style.marginTop = "8px"; none.textContent = "No recent original post found right now.";
      const retry = document.createElement("button"); retry.className = "tg-find"; retry.textContent = "Check again"; retry.disabled = locked; retry.onclick = () => void findTargetPost(tg.handle);
      c.append(none, retry);
    } else {
      const pv = document.createElement("div"); pv.className = "tg-post"; pv.textContent = post.text; c.append(pv);
      const fl = freshnessLabel(post.postedAt, now);
      if (fl) { const f = document.createElement("div"); f.className = `tg-fresh ${fl.live ? "tg-live" : ""}`; f.textContent = (fl.live ? "● " : "") + fl.text; c.append(f); }
      const rising = opportunityMomentum(post.id, now);
      if (rising && rising.score >= 0.25 && !!fl?.live && slotOdds(post.replies) > 0.45) {
        const mv = document.createElement("div"); mv.className = "tg-fresh tg-live";
        const pace = rising.viewsPerHour != null ? `${fmtCount(Math.round(rising.viewsPerHour))} views/hr` : `${fmtCount(Math.round(rising.engagementsPerHour ?? 0))} engagements/hr`;
        mv.textContent = `↗ Picking up · ~${pace}`;
        mv.title = "Measured from two RapidAPI snapshots. This gives the target a small freshness tie-break only; it does not override fit or reply competition."; c.append(mv);
      }
      // The FREE competition read (reply count came with the fetch): early = high-impression window.
      const early = earlyLabel(post.replies, post.postedAt, now);
      if (early) { const e = document.createElement("div"); e.className = `tg-fresh ${early.level === "early" ? "tg-live" : ""}`; e.textContent = (early.level === "early" ? "◔ " : "") + early.text; c.append(e); }
      const draft = targetDrafts.get(tg.handle);
      if (!draft) {
        const d = document.createElement("button"); d.className = "tg-find"; d.textContent = busy ? "Drafting…" : "Draft a reply ↗"; d.disabled = busy || locked; d.onclick = () => void draftTargetReply(tg.handle); c.append(d);
      } else {
        const ta = document.createElement("textarea"); ta.className = "idea-ta"; ta.value = draft; ta.rows = Math.min(8, Math.max(3, Math.ceil(draft.length / 42))); ta.style.fontSize = "13.5px"; ta.style.marginTop = "8px";
        ta.oninput = () => { targetDrafts.set(tg.handle, ta.value); };
        c.append(ta);
        const warn = replyQualityWarning(draft); if (warn) { const w = document.createElement("div"); w.className = "tg-warn"; w.textContent = warn; c.append(w); }
        const row = document.createElement("div"); row.className = "idea-actions";
        const manualReview = !xReplyInsertOn || opps.get(post.id)?.source === "fresh-reach";
        const handoff = document.createElement("button"); handoff.className = "idea-open"; handoff.textContent = manualReview ? "Review & reply on X ↗" : "Like + insert reply in X";
        handoff.onclick = () => {
          const liveDraft = targetDrafts.get(tg.handle) || "";
          const sharedOpp = opps.get(post.id);
          draftOppId = post.id; draftOppAuthor = tg.handle;
          lastDraft = { author: post.author, text: post.text, oppId: post.id, angle: initialAngle(sharedOpp?.category) };
          void runReplyDraftAction(liveDraft);
        };
        row.append(handoff); c.append(row);
        const foot = document.createElement("div"); foot.className = "tg-foot"; foot.textContent = !manualReview
          ? "Your click tries Like + insert first and updates local activity on success; off-page posts fall back to the exact-post review flow. Nothing submits on its own."
          : "Manual review mode. If this post is visible, Goobi uses its Reply control in place; off-page posts open their exact status page. You edit and post it yourself, then confirm it in Goobi.";
        c.append(foot);
      }
    }
    body.append(c);
  }
  wrap.append(body);
  return wrap;
}

function buildDms(): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "ideas dm-workspace";
  const head = document.createElement("div"); head.className = "ideahead dm-head";
  const sub = document.createElement("div"); sub.className = "ideasub";
  sub.textContent = "Turn real public signals into thoughtful private conversations. Goobi finds context and drafts; you decide whom to contact and send every message yourself.";
  head.append(sub);
  if (!dmStore.ownerHandle) {
    const gate = document.createElement("div"); gate.className = "idea-gate";
    const gt = document.createElement("div"); gt.className = "ideagate-t"; gt.textContent = "Set your X handle first";
    const gp = document.createElement("div"); gp.className = "ideasub"; gp.textContent = "The DM workspace is isolated per account. Add your handle in the Goobi side panel, then reopen it here.";
    gate.append(gt, gp); head.append(gate); wrap.append(head); return wrap;
  }

  const pace = dmPacingStatus(dmStore, Date.now()), due = dueFollowUps(dmStore, Date.now());
  const visibleCandidates = dmStore.candidates.filter((c) => !c.removedAt);
  const stats = document.createElement("div"); stats.className = "dm-stats";
  const stat = (label: string, value: number, hot = false) => { const s = document.createElement("span"); s.className = "dm-stat" + (hot ? " hot" : ""); s.textContent = `${label} ${value}`; return s; };
  stats.append(stat("Due", due.length, due.length > 0), stat("Ready", visibleCandidates.filter((c) => c.stage === "ready").length), stat("Conversations", visibleCandidates.filter((c) => c.stage === "active").length));
  const paceEl = document.createElement("span"); paceEl.className = `dm-pace ${pace.level}`; paceEl.textContent = `${pace.firstDay} first · ${pace.totalDay} total today`; paceEl.title = "Based only on messages you marked sent in Goobi."; stats.append(paceEl); head.append(stats);

  // One decision, not a dashboard wall: real conversations and due follow-ups always beat new outreach.
  const intelligence = deriveDmMetrics(dmStore), nextAction = rankDmNextActions(dmStore, Date.now())[0];
  if (nextAction) {
    const next = document.createElement("div"); next.className = "dm-next";
    const mark = document.createElement("span"); mark.className = "dm-next-mark"; mark.textContent = "NEXT";
    const copy = document.createElement("div"); copy.className = "dm-next-copy";
    const label = document.createElement("div"); label.className = "dm-next-label"; label.textContent = nextAction.label;
    const whyNext = document.createElement("div"); whyNext.className = "dm-next-why"; whyNext.textContent = nextAction.why; copy.append(label, whyNext); next.append(mark, copy);
    const act = document.createElement("button"); act.className = "idea-open dm-next-act";
    act.textContent = nextAction.kind === "reply" ? "Reply" : nextAction.kind === "follow_up" ? "Follow up" : nextAction.kind === "draft_first" ? "Draft" : nextAction.kind === "mark_ready" ? "Mark ready" : "Open plan";
    act.onclick = () => {
      const candidate = dmStore.candidates.find((c) => c.handle === nextAction.handle); if (!candidate) return;
      dmExpanded.add(candidate.handle);
      if (nextAction.kind === "mark_ready") dmMutate(updateDmCandidate(dmStore, candidate.handle, { stage: "ready" }, Date.now()));
      else if (nextAction.kind === "reply" && !candidate.draft) void draftDmFor(candidate, "reply");
      else if (nextAction.kind === "follow_up" && !candidate.draft) void draftDmFor(candidate, "follow_up");
      else if (nextAction.kind === "draft_first" && !candidate.draft) void draftDmFor(candidate, "first");
      else renderDock();
    };
    next.append(act); head.append(next);
  }
  const outcomes = document.createElement("div"); outcomes.className = "dm-outcomes";
  if (intelligence.firstSent) {
    const rate = document.createElement("b"); rate.textContent = `${Math.round(intelligence.replyRate * 100)}% marked reply rate`;
    outcomes.append(rate, document.createTextNode(` · ${intelligence.conversations} conversations · ${intelligence.wins} won`));
  }
  const learning = document.createElement("span"); learning.className = "dm-learning"; learning.textContent = intelligence.insight; outcomes.append(learning); outcomes.title = "Based only on first messages, replies, and outcomes you manually marked in Goobi. Display-only; this does not change ranking or automate outreach."; head.append(outcomes);
  if (intelligence.peopleInsight) { const people = document.createElement("span"); people.className = "dm-learning dm-people-learning"; people.textContent = intelligence.peopleInsight; outcomes.append(people); }

  const add = document.createElement("div"); add.className = "dm-add";
  const handle = document.createElement("input"); handle.className = "idea-steerin"; handle.placeholder = "@handle"; handle.setAttribute("aria-label", "X handle to add");
  const why = document.createElement("input"); why.className = "idea-steerin dm-why-input"; why.placeholder = "Why now? Add a specific reason…"; why.setAttribute("aria-label", "Why contact this person now");
  const addB = document.createElement("button"); addB.className = "scanb"; addB.textContent = dmAdding ? "Checking…" : "Add person"; addB.disabled = dmAdding;
  const doAdd = () => { const h = handle.value, note = why.value; handle.value = ""; why.value = ""; void addDmByHandle(h, note); };
  addB.onclick = doAdd; why.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } };
  add.append(handle, why, addB); head.append(add);
  if (dmAddMsg) { const msg = document.createElement("div"); msg.className = "dm-message"; msg.textContent = dmAddMsg; head.append(msg); }
  wrap.append(head);

  const body = document.createElement("div"); body.className = "dl dm-list";
  const suggestions = dmSuggestions();
  if (suggestions.length) {
    const block = document.createElement("section"); block.className = "dm-suggestions";
    const sh = document.createElement("div"); sh.className = "dm-section-title"; sh.textContent = "People worth considering"; block.append(sh);
    const note = document.createElement("div"); note.className = "dm-section-sub"; note.textContent = "Warm relationships first; saved targets stay research—not assumed interest."; block.append(note);
    for (const s of suggestions) {
      const row = document.createElement("div"); row.className = "dm-suggestion"; row.append(avatarChip(s.handle, s.avatar));
      const mid = document.createElement("div"); mid.className = "dm-suggestion-main";
      const name = document.createElement("a"); name.className = "ins-h"; name.textContent = `@${s.handle}`; name.href = `https://x.com/${s.handle}`; name.target = "_blank"; name.rel = "noopener";
      const reason = document.createElement("div"); reason.className = "ins-meta"; reason.textContent = s.reason; mid.append(name, reason); row.append(mid);
      const badge = document.createElement("span"); badge.className = `dm-warm ${s.warm ? "warm" : "research"}`; badge.textContent = s.warm ? "Warm" : "Research"; row.append(badge);
      const plan = document.createElement("button"); plan.className = "scanb dm-plan"; plan.textContent = "+ Plan";
      plan.onclick = () => { const now = Date.now(); planDm({ handle: s.handle, name: s.name, avatar: s.avatar, followers: s.followers, bioSnapshot: s.bio, source: s.source, intent: s.intent, stage: s.warm ? "ready" : "research", reasons: [{ id: `suggest:${s.handle}`, label: s.reason, detail: s.publicContext, source: s.warm ? "measured" : "observed", capturedAt: now }], context: s.publicContext ? [{ id: `suggest-context:${s.handle}`, kind: "public_post", source: "observed", text: s.publicContext, capturedAt: now }] : [] }); };
      row.append(plan); block.append(row);
    }
    body.append(block);
  }

  const candidates = sortDmCandidates(dmStore, Date.now());
  if (!candidates.length) {
    const empty = document.createElement("div"); empty.className = "idea-empty dm-empty";
    empty.textContent = suggestions.length ? "Plan someone above, add an @handle, or move a person here from Targets." : "Add an @handle or move someone here from Targets. Start with a real reason—not a list.";
    body.append(empty);
  }
  for (const candidate of candidates) {
    const open = dmExpanded.has(candidate.handle), isDue = due.some((c) => c.handle === candidate.handle);
    const card = document.createElement("article"); card.className = `dm-card${open ? " open" : ""}${isDue ? " due" : ""}`;
    const top = document.createElement("div"); top.className = "dm-card-top"; top.append(avatarChip(candidate.handle, candidate.avatar));
    const ident = document.createElement("div"); ident.className = "dm-ident";
    const name = document.createElement("a"); name.className = "ins-h"; name.textContent = `@${candidate.handle}`; name.href = `https://x.com/${candidate.handle}`; name.target = "_blank"; name.rel = "noopener";
    const meta = document.createElement("div"); meta.className = "ins-meta"; meta.textContent = [DM_INTENT_LABEL[candidate.intent], candidate.followers != null ? `${fmtCount(candidate.followers)} followers` : "", candidate.touches.length ? `${candidate.touches.length} logged touch${candidate.touches.length === 1 ? "" : "es"}` : "No private history yet", dmDueLabel(candidate)].filter(Boolean).join(" · ");
    ident.append(name, meta); top.append(ident);
    const stage = document.createElement("span"); stage.className = `dm-stage ${candidate.stage}`; stage.textContent = isDue ? "Follow-up due" : DM_STAGE_LABEL[candidate.stage]; top.append(stage);
    const toggle = document.createElement("button"); toggle.className = "dm-toggle"; toggle.textContent = open ? "▾" : "▸"; toggle.title = open ? "Collapse" : "Open plan"; toggle.setAttribute("aria-expanded", String(open));
    toggle.onclick = () => { open ? dmExpanded.delete(candidate.handle) : dmExpanded.add(candidate.handle); renderDock(); }; top.append(toggle); card.append(top);

    const evidence = document.createElement("div"); evidence.className = "dm-evidence";
    evidence.textContent = candidate.reasons.length ? candidate.reasons.map((r) => `◆ ${r.label}${r.detail ? ` — ${r.detail}` : ""}`).join("\n") : "Add a real reason before drafting."; card.append(evidence);
    const learnedSignals = candidateDmSignal(candidate, intelligence);
    if (learnedSignals.length) { const signal = document.createElement("div"); signal.className = "dm-candidate-signal"; signal.textContent = `✓ Your marked history · ${learnedSignals.join(" · ")}`; signal.title = "Observed correlation from your manually marked first messages and replies. It does not prove this person will reply and does not change their rank."; card.append(signal); }
    if (!open) { body.append(card); continue; }

    const controls = document.createElement("div"); controls.className = "dm-controls";
    const intent = document.createElement("select"); intent.className = "dm-select"; intent.setAttribute("aria-label", "DM angle");
    (Object.keys(DM_INTENT_LABEL) as DmIntent[]).forEach((id) => { const o = document.createElement("option"); o.value = id; o.textContent = DM_INTENT_LABEL[id]; o.selected = candidate.intent === id; intent.append(o); });
    intent.onchange = () => dmMutate(updateDmCandidate(dmStore, candidate.handle, { intent: intent.value as DmIntent, draft: undefined, draftPhase: undefined, stage: candidate.stage === "ready" ? "research" : candidate.stage }, Date.now())); controls.append(intent);
    if (xProducts.length) {
      const product = document.createElement("select"); product.className = "dm-select dm-product"; product.setAttribute("aria-label", "Product or resource");
      const none = document.createElement("option"); none.value = ""; none.textContent = "No product/resource"; product.append(none);
      xProducts.forEach((p) => { const o = document.createElement("option"); o.value = p.name; o.textContent = p.name; o.selected = candidate.productName === p.name; product.append(o); });
      product.onchange = () => dmMutate(updateDmCandidate(dmStore, candidate.handle, { productName: product.value || undefined, draft: undefined, draftPhase: undefined, stage: candidate.stage === "ready" ? "research" : candidate.stage }, Date.now())); controls.append(product);
    }
    card.append(controls);
    const goal = document.createElement("textarea"); goal.className = "dm-goal"; goal.rows = 2; goal.value = candidate.goal || ""; goal.placeholder = "Goal and angle: what would make this conversation useful for both of you?";
    goal.oninput = () => { dmStore = updateDmCandidate(dmStore, candidate.handle, { goal: goal.value, draft: undefined, draftPhase: undefined, stage: candidate.stage === "ready" ? "research" : candidate.stage }, Date.now()); };
    goal.onblur = () => { persistDms(); renderDock(); }; card.append(goal);

    const visibleContext = candidate.context.filter((x) => !x.removedAt);
    if (visibleContext.length) {
      const context = document.createElement("div"); context.className = "dm-context";
      const label = document.createElement("div"); label.className = "dm-mini-title"; label.textContent = "Saved context"; context.append(label);
      for (const item of visibleContext.slice().reverse()) {
        const row = document.createElement("div"); row.className = "dm-context-row";
        const copy = document.createElement("div"); copy.className = "dm-context-copy"; copy.textContent = `${item.kind.replace("_", " ")} · ${item.text || item.url || ""}`; row.append(copy);
        const rm = document.createElement("button"); rm.className = "dm-remove"; rm.textContent = "×"; rm.title = "Remove this saved context"; rm.onclick = () => dmMutate(removeDmContext(dmStore, candidate.handle, item.id, Date.now())); row.append(rm); context.append(row);
      }
      card.append(context);
    }

    if (candidate.draft) {
      const draft = document.createElement("textarea"); draft.className = "idea-ta dm-draft"; draft.rows = Math.min(9, Math.max(4, Math.ceil(candidate.draft.length / 60))); draft.value = candidate.draft; draft.setAttribute("aria-label", "Editable DM draft");
      draft.oninput = () => { dmStore = updateDmCandidate(dmStore, candidate.handle, { draft: draft.value }, Date.now()); };
      draft.onblur = () => persistDms(); card.append(draft);
      const duplicate = findDmDuplicate(dmStore, candidate.draft);
      if (duplicate) { const warning = document.createElement("div"); warning.className = "dm-warning"; warning.textContent = `Too similar to a recent DM to @${duplicate.handle}. Add something specific before marking sent.`; card.append(warning); }
      const actions = document.createElement("div"); actions.className = "dm-actions";
      const draftLifecycle = candidate.draftPhase ? canDraftDm(candidate, candidate.draftPhase, Date.now()) : { ok: false, reason: "Regenerate this draft." };
      const copy = document.createElement("button"); copy.className = "idea-copy"; copy.textContent = "Copy"; copy.disabled = !!duplicate || !draftLifecycle.ok; copy.title = duplicate ? "Edit this draft until it is specific enough to differ from recent DMs." : draftLifecycle.reason || "Copy this draft"; copy.onclick = async () => { try { const live = dmStore.candidates.find((c) => c.handle === candidate.handle); const gate = live?.draftPhase ? canDraftDm(live, live.draftPhase, Date.now()) : { ok: false }; if (!live?.draft || !gate.ok || findDmDuplicate(dmStore, live.draft)) { toast("This draft is stale or too similar. Regenerate or edit it before copying."); return; } await navigator.clipboard.writeText(live.draft); copy.textContent = "Copied ✓"; setTimeout(() => (copy.textContent = "Copy"), 1400); } catch { /* ignore */ } };
      const openProfile = document.createElement("button"); openProfile.className = "idea-copy"; openProfile.textContent = "Open profile ↗"; openProfile.onclick = () => window.open(`https://x.com/${candidate.handle}`, "_blank", "noopener");
      const sent = document.createElement("button"); sent.className = "idea-open"; sent.textContent = "Mark sent"; sent.title = "Manual record only—Goobi cannot verify DM delivery or reads."; sent.onclick = () => markCurrentDmSent(candidate.handle);
      actions.append(copy, openProfile, sent); card.append(actions);
    } else {
      const actions = document.createElement("div"); actions.className = "dm-actions";
      const phase: DmPhase = candidate.stage === "active" ? "reply" : candidate.stage === "waiting" ? "follow_up" : "first";
      const draft = document.createElement("button"); draft.className = "idea-open"; draft.textContent = dmBusy.has(candidate.handle) ? "Drafting…" : candidate.stage === "research" || candidate.stage === "warming" ? "Mark ready first" : candidate.stage === "closed" || candidate.stage === "won" ? "Reopen first" : phase === "follow_up" ? "Draft follow-up" : phase === "reply" ? "Draft reply" : "Draft first DM"; draft.disabled = dmBusy.has(candidate.handle) || (phase === "follow_up" && !isDue) || candidate.stage === "research" || candidate.stage === "warming" || candidate.stage === "closed" || candidate.stage === "won"; draft.onclick = () => void draftDmFor(candidate, phase); actions.append(draft);
      const profile = document.createElement("button"); profile.className = "idea-copy"; profile.textContent = "Open profile ↗"; profile.onclick = () => window.open(`https://x.com/${candidate.handle}`, "_blank", "noopener"); actions.append(profile); card.append(actions);
    }

    const secondary = document.createElement("div"); secondary.className = "dm-secondary";
    if (candidate.stage === "research" || candidate.stage === "warming") {
      const ready = document.createElement("button"); ready.className = "idea-pin"; ready.textContent = "Mark ready"; ready.onclick = () => { const live = dmStore.candidates.find((c) => c.handle === candidate.handle) ?? candidate; const gate = canMoveDmReady(live); if (!gate.ok) { toast(gate.reason || "Add specific context first."); return; } dmMutate(updateDmCandidate(dmStore, candidate.handle, { stage: "ready", draft: undefined, draftPhase: undefined }, Date.now())); }; secondary.append(ready);
    }
    if (candidate.stage === "waiting") {
      const snooze = document.createElement("button"); snooze.className = "idea-pin"; snooze.textContent = "Snooze 7d"; snooze.onclick = () => dmMutate(updateDmCandidate(dmStore, candidate.handle, { snoozedUntil: Date.now() + 7 * DAY_MS, draft: undefined, draftPhase: undefined }, Date.now())); secondary.append(snooze);
    }
    if (candidate.stage === "active") {
      const won = document.createElement("button"); won.className = "idea-pin"; won.textContent = "Mark won"; won.onclick = () => dmMutate(updateDmCandidate(dmStore, candidate.handle, { stage: "won", draft: undefined, draftPhase: undefined, dueAt: undefined, snoozedUntil: undefined }, Date.now())); secondary.append(won);
    }
    if (candidate.stage === "won" || candidate.stage === "closed") {
      const reopen = document.createElement("button"); reopen.className = "idea-pin"; reopen.textContent = "Reopen"; reopen.onclick = () => dmMutate(updateDmCandidate(dmStore, candidate.handle, { stage: "research", draft: undefined, draftPhase: undefined }, Date.now())); secondary.append(reopen);
    } else {
      const close = document.createElement("button"); close.className = "idea-pin"; close.textContent = "Close"; close.onclick = () => dmMutate(updateDmCandidate(dmStore, candidate.handle, { stage: "closed", draft: undefined, draftPhase: undefined, dueAt: undefined, snoozedUntil: undefined }, Date.now())); secondary.append(close);
    }
    const refresh = document.createElement("button"); refresh.className = "idea-pin"; refresh.textContent = dmBusy.has(candidate.handle) ? "Refreshing…" : "Refresh public context"; refresh.disabled = dmBusy.has(candidate.handle) || dmContextRefreshes >= 2; refresh.onclick = () => void refreshDmContext(candidate.handle); secondary.append(refresh);
    const remove = document.createElement("button"); remove.className = "idea-pin idea-delete"; remove.textContent = "Remove"; remove.onclick = () => { if (window.confirm(`Remove @${candidate.handle} and its locally saved DM context?`)) dmMutate(removeDmCandidate(dmStore, candidate.handle, Date.now())); }; secondary.append(remove); card.append(secondary);

    const capture = document.createElement("div"); capture.className = "dm-capture";
    const captureInput = document.createElement("textarea"); captureInput.className = "dm-goal"; captureInput.rows = 2; captureInput.placeholder = "Paste what they said, or add a private conversation note…"; captureInput.value = dmContextDrafts.get(candidate.handle) || ""; captureInput.oninput = () => dmContextDrafts.set(candidate.handle, captureInput.value); capture.append(captureInput);
    const captureActions = document.createElement("div"); captureActions.className = "dm-actions compact";
    const reply = document.createElement("button"); reply.className = "idea-copy"; reply.textContent = "They replied"; reply.onclick = () => saveDmContext(candidate, "message", true);
    const noteB = document.createElement("button"); noteB.className = "idea-copy"; noteB.textContent = "Save note"; noteB.onclick = () => saveDmContext(candidate, "note"); captureActions.append(reply, noteB); capture.append(captureActions); card.append(capture);

    if (candidate.touches.length) {
      const timeline = document.createElement("div"); timeline.className = "dm-timeline";
      const tl = document.createElement("div"); tl.className = "dm-mini-title"; tl.textContent = "Conversation history (you marked)"; timeline.append(tl);
      for (const touch of candidate.touches.slice().reverse()) {
        const row = document.createElement("div"); row.className = `dm-touch ${touch.direction}`;
        const copy = document.createElement("span"); copy.textContent = `${touch.direction === "outbound" ? "You" : "Them"} · ${touch.phase.replace("_", " ")} · ${dmAge(touch.at)}${touch.text ? ` — ${touch.text}` : " · text removed"}`; row.append(copy);
        if (touch.text) { const redact = document.createElement("button"); redact.className = "dm-remove"; redact.textContent = "×"; redact.title = "Remove the saved private message text; keep the manual event marker"; redact.onclick = () => dmMutate(redactDmTouch(dmStore, candidate.handle, touch.id, Date.now())); row.append(redact); }
        timeline.append(row);
      }
      card.append(timeline);
    }
    const disclosure = document.createElement("div"); disclosure.className = "dm-disclosure"; disclosure.textContent = `Manual record · ${followUpCount(candidate)}/1 unanswered follow-up used. Private context stays in Chrome local storage; only the most recent 8 visible context items and 12 visible message texts go to Claude when you click Draft.`; card.append(disclosure);
    body.append(card);
  }
  const foot = document.createElement("div"); foot.className = "dm-footer"; foot.textContent = "Goobi never sends DMs automatically. X delivery, reads, and replies are not verified; the pipeline reflects what you mark."; body.append(foot);
  wrap.append(body); return wrap;
}

function buildIdeas(): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "ideas";
  const nicheReady = !!xNiche.trim();
  const working = workingIdeas(); const posted = postedIdeas();
  const seedDrafts = working.filter((i) => i.origin === "seed");
  const suggestions = working.filter((i) => i.origin !== "seed");

  // Primary creation path: one thought in, one editable post out.
  const compose = document.createElement("section"); compose.className = "idea-compose"; compose.setAttribute("aria-labelledby", "rough-idea-title");
  const composeTop = document.createElement("div"); composeTop.className = "idea-compose-top";
  const composeCopy = document.createElement("div");
  const composeTitle = document.createElement("div"); composeTitle.className = "idea-compose-title"; composeTitle.id = "rough-idea-title"; composeTitle.textContent = "Start with a rough idea";
  const composeSub = document.createElement("div"); composeSub.className = "idea-compose-sub"; composeSub.textContent = "Goobi will shape the thought in your voice. You review every word.";
  composeCopy.append(composeTitle, composeSub); composeTop.append(composeCopy); compose.append(composeTop);
  const rough = document.createElement("textarea"); rough.className = "idea-rough"; rough.rows = 3; rough.value = roughIdea;
  rough.placeholder = "e.g. Shipping faster got easier when I stopped treating every feature like a launch…";
  rough.setAttribute("aria-label", "Rough post idea"); rough.disabled = roughBusy;
  rough.oninput = () => { roughIdea = rough.value; polish.disabled = !rough.value.trim() || roughBusy; roughCount.textContent = `${rough.value.trim().length} characters`; };
  rough.onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && rough.value.trim() && !roughBusy) { e.preventDefault(); roughIdea = rough.value; void polishRoughIdea(); } };
  const composeActions = document.createElement("div"); composeActions.className = "idea-compose-actions";
  const roughCount = document.createElement("span"); roughCount.className = "idea-rough-count"; roughCount.textContent = `${roughIdea.trim().length} characters`;
  const polish = document.createElement("button"); polish.className = "idea-polish"; polish.textContent = roughBusy ? "Polishing…" : "Polish into a post"; polish.disabled = !roughIdea.trim() || roughBusy; polish.title = "Polish this idea (⌘/Ctrl + Enter)";
  polish.onclick = () => { roughIdea = rough.value; void polishRoughIdea(); };
  composeActions.append(roughCount, polish); compose.append(rough, composeActions);
  if (roughBusy) { const busy = document.createElement("div"); busy.className = "idea-compose-status"; busy.setAttribute("role", "status"); busy.textContent = "Shaping one editable post from your thought…"; compose.append(busy); }
  if (roughError) { const er = document.createElement("div"); er.className = "idea-compose-error"; er.setAttribute("role", "alert"); er.textContent = roughError; compose.append(er); }
  wrap.append(compose);

  if (seedDrafts.length) {
    const seeds = document.createElement("section"); seeds.className = "idea-seeds";
    const st = document.createElement("div"); st.className = "idea-section-title"; st.textContent = `Your drafts (${seedDrafts.length})`; seeds.append(st);
    for (const idea of seedDrafts) seeds.append(ideaCard(idea));
    wrap.append(seeds);
  }

  const head = document.createElement("div"); head.className = "ideahead";
  const activeStrategy = activeGrowthExperiment(growthStore);
  if (activeStrategy) {
    const strategy = growthStrategy(activeStrategy.strategyId);
    const test = document.createElement("div"); test.className = "idea-trend";
    test.textContent = `14-day test · ${strategy.label}: 3 ideas follow this bet; 2 stay exploratory.`;
    test.title = `Active hypothesis: ${strategy.hypothesis}`;
    head.append(test);
  }
  // Row 1 — streak (left) + the Generate action anchored top-right (no longer buried mid-stack).
  const top = document.createElement("div"); top.className = "ideahead-top";
  const left = document.createElement("div");
  if (posted.length) {
    left.className = "idea-streak";
    const streak = postedStreak();
    left.append(document.createTextNode(`Posted ${posted.length}`));
    if (streak) { left.append(document.createTextNode(" · ")); const b = document.createElement("b"); b.textContent = `🔥 ${streak}-day`; left.append(b); }
  }
  const sectionTitle = document.createElement("div"); sectionTitle.className = "idea-section-title"; sectionTitle.textContent = `Suggestions (${suggestions.length})`;
  left.prepend(sectionTitle);
  const gen = document.createElement("button"); gen.className = "scanb";
  gen.textContent = ideasLoading ? "Finding…" : "Generate 5";
  gen.disabled = ideasLoading || !nicheReady; gen.title = nicheReady ? "Find fresh post suggestions from what's working in your niche" : "Set your niche in the Goobi panel first"; gen.onclick = () => void generateIdeas();
  const pinnedSuggestions = suggestions.filter((i) => i.pinned).length;
  const clear = document.createElement("button"); clear.className = "idea-clear" + (clearIdeasArmed ? " armed" : "");
  clear.textContent = clearIdeasArmed ? `Clear ${suggestions.length}${pinnedSuggestions ? ` (${pinnedSuggestions} pinned)` : ""}?` : "Clear suggestions";
  clear.title = "Clear generated suggestions only; your rough-idea drafts and posted history are preserved";
  clear.disabled = !suggestions.length || ideasLoading; clear.onclick = clearWorkingIdeas;
  const undoClear = document.createElement("button"); undoClear.className = "idea-clear"; undoClear.textContent = "Undo clear"; undoClear.hidden = !clearedSuggestions.length; undoClear.onclick = undoClearSuggestions;
  const rgrp = document.createElement("div"); rgrp.className = "idea-head-actions"; rgrp.append(gen, clear, undoClear);
  top.append(left, rgrp); head.append(top);
  if (!nicheReady) { const n = document.createElement("div"); n.className = "idea-niche-note"; n.textContent = "Set your niche in the Goobi panel to generate suggestions. You can still polish your own idea above."; head.append(n); }
  // Batch call-out summary — always visible so you triage at a glance ("2 strong to ship, 1 weak to fix").
  const graded = suggestions.filter((i) => i.grade);
  if (graded.length) {
    const counts: Record<"strong" | "ok" | "weak", number> = { strong: 0, ok: 0, weak: 0 };
    for (const i of graded) counts[i.grade!.tier]++;
    const sm = document.createElement("div"); sm.className = "idea-summary";
    (["strong", "ok", "weak"] as const).forEach((t) => {
      if (!counts[t]) return;
      if (sm.childNodes.length) sm.append(document.createTextNode(" · "));
      const s = document.createElement("b"); s.textContent = `${TIER_UI[t].icon} ${counts[t]} ${TIER_UI[t].label}`; s.style.color = TIER_UI[t].color; sm.append(s);
    });
    sm.title = "How many working drafts read as unmistakably YOU (strong) vs generic-leaning (ok/weak). Ship the strong; tap ✎ Improve on the rest.";
    head.append(sm);
  }
  if (ideasInsightsOpen) { // the insight rows below collapse by default so the idea LIST gets the room
  // Row 2 — sub + reach folded into one muted line.
  const sub = document.createElement("div"); sub.className = "ideasub";
  sub.textContent = "Remixes your niche's winning patterns into your voice — you review and post." + (myFollowers > 0 ? ` · tuned to ~${fmtCount(myFollowers)} followers` : "");
  head.append(sub);
  // Row 3 — the batch's shapes (MODEL-picked patterns; distinct from the measured line below).
  const pats = Array.from(new Set(suggestions.map((i) => i.pattern).filter(Boolean))).slice(0, 3);
  if (pats.length) { const tr = document.createElement("div"); tr.className = "idea-trend"; tr.append(document.createTextNode("Batch shapes (model-picked): ")); const b = document.createElement("b"); b.textContent = pats.join(" · "); tr.append(b); head.append(tr); }
  // Row 4 — exact idea outcomes take precedence; until enough settle, use all own posts as context.
  const ideaMsl = measuredIdeaShapeLine();
  if (ideaMsl) {
    const tr = document.createElement("div"); tr.className = "idea-trend";
    tr.textContent = `✓ Verified idea results: ${ideaMsl.line.split("their ").join("your ")}`;
    tr.title = `Only drafts uniquely matched to real X posts, settled >48h, using X-reported ${ideaMsl.metric}. This is the signal future idea batches receive.`;
    head.append(tr);
  }
  const msl = ideaMsl ? null : measuredShapeLine();
  if (msl) {
    const tr = document.createElement("div"); tr.className = "idea-trend";
    tr.textContent = `📐 Measured: ${msl.line.split("their ").join("your ")}`;
    tr.title = `From your own settled posts (>48h old, X-reported ${msl.metric}), shape median vs your overall median, n=${msl.n}. Correlation, not causation — the generator gets this as a soft preference, never a rule.`;
    head.append(tr);
  }
  // Row 5 — biggest one-day gainer this week (topPostId was computed daily and consumed by nothing).
  {
    let bestDay: { views: number; id: string } | undefined;
    const cut = dayKey(Date.now() - 7 * 24 * HOUR_MS);
    for (const [k, sn] of Object.entries(learn.snaps)) {
      if (k >= cut && sn.hadViews && sn.topPostId && (bestDay == null || sn.views > bestDay.views)) bestDay = { views: sn.views, id: sn.topPostId };
    }
    const post = bestDay ? (ownStats ?? []).find((pp) => pp.id === bestDay!.id) : undefined;
    if (bestDay && post && bestDay.views > 0) {
      const tr = document.createElement("div"); tr.className = "idea-trend";
      tr.textContent = `📈 Biggest one-day gainer this week: “${post.text.slice(0, 56)}${post.text.length > 56 ? "…" : ""}” +${fmtCount(bestDay.views)} views`;
      tr.title = "Measured: the post that drove your largest single-day view growth in the last 7 days (X-reported, daily scan). A one-day delta, not a weekly total.";
      head.append(tr);
    }
  }
  } // end ideasInsightsOpen — the collapsed insight rows
  wrap.append(head);

  const body = document.createElement("div"); body.className = "dl idea-list";
  if (ideasLoading) {
    const stage = document.createElement("div"); stage.className = "idea-load"; // Goobi dances here (mounted after the dock is in the DOM)
    const cap = document.createElement("div"); cap.className = "idea-loadcap"; cap.textContent = "Reading the top posts in your niche, then writing in your voice…";
    body.append(stage, cap);
    for (const idea of suggestions) { const card = ideaCard(idea); card.classList.add("dimmed"); body.append(card); } // your queue stays visible through a generate
  } else if (ideasError) {
    const err = document.createElement("div"); err.className = "idea-err";
    const et = document.createElement("div"); et.className = "idea-err-t"; et.textContent = ideasError; err.append(et);
    const retry = document.createElement("button"); retry.className = "scanb"; retry.textContent = "Try again"; retry.onclick = () => void generateIdeas(); err.append(retry);
    body.append(err);
    for (const idea of suggestions) body.append(ideaCard(idea));
  } else {
    if (!suggestions.length) { const e = document.createElement("div"); e.className = "idea-empty"; e.textContent = nicheReady ? "No suggestions yet. Generate five when you want fresh angles from your niche." : "Set your niche in the Goobi panel when you want generated suggestions."; body.append(e); }
    for (const idea of suggestions) body.append(ideaCard(idea));
    // Shipped — collapsed.
    if (posted.length) {
      const tog = document.createElement("div"); tog.className = "idea-shiptog"; tog.textContent = `${shippedOpen ? "▾" : "▸"} Posted history (${posted.length})`;
      tog.onclick = () => { shippedOpen = !shippedOpen; renderDock(); };
      body.append(tog);
      if (shippedOpen) for (const idea of posted) body.append(ideaCard(idea, { shipped: true }));
    }
  }
  wrap.append(body);
  return wrap;
}

/* ---------- Growth loop: one account-level strategy bet at a time ---------- */

function growthDecisionLabel(decision: ReturnType<typeof evaluateGrowthExperiment>["decision"]): string {
  return decision === "double-down" ? "Double down" : decision === "switch" ? "Shake it up" : decision === "tighten" ? "Tighten one lever" : "Keep collecting";
}
function growthExecutionInsights(experimentId: string, now: number): string[] {
  const lines: string[] = [];
  const fl = learnFeatures(replyLog.sent.filter((r) => r.growthExperimentId === experimentId), now);
  const strongAngle = fl.angles.find((a) => a.rel >= 1.15);
  const weakAngle = [...fl.angles].reverse().find((a) => a.rel <= 0.85);
  if (strongAngle) lines.push(`${catLabel(strongAngle.angle)} replies ran at ${strongAngle.rel.toFixed(1)}× this test's average (n=${strongAngle.n})`);
  if (weakAngle && weakAngle.angle !== strongAngle?.angle) lines.push(`${catLabel(weakAngle.angle)} replies ran at ${weakAngle.rel.toFixed(1)}× this test's average (n=${weakAngle.n})`);
  const ideaPosts = ideaQueue.filter((i) => i.growthExperimentId === experimentId && i.publication).map((i) => ({ text: i.text, postedAt: i.publication!.postedAt ?? i.postedAt, views: i.publication!.views, likes: i.publication!.likes, reposts: i.publication!.reposts }));
  const shapes = shapePerformance(ideaPosts, now);
  const strongShape = shapes?.shapes.find((s) => s.rel >= 1.15);
  if (strongShape) lines.push(`${strongShape.shape} posts ran at ${strongShape.rel.toFixed(1)}× this test's median (${shapes!.metric}, n=${strongShape.n})`);
  return lines.slice(0, 2);
}
function buildGrowth(): HTMLElement {
  const now = Date.now();
  const wrap = document.createElement("div"); wrap.className = "growth";
  const current = summarizeGrowthWindow(growthStore, now - GROWTH_WINDOW_DAYS * DAY_MS, now);
  const prior = summarizeGrowthWindow(growthStore, now - 2 * GROWTH_WINDOW_DAYS * DAY_MS, now - GROWTH_WINDOW_DAYS * DAY_MS - 1);
  const currentProfileState = profileStateForCurrentOwner();
  const findings = profileCheck(currentProfileState, ownStats ?? []);
  const profileNeedsWork = findings.some((f) => f.level === "act");
  const active = activeGrowthExperiment(growthStore);

  const hero = document.createElement("section"); hero.className = "gx-hero";
  const kick = document.createElement("div"); kick.className = "gx-kicker"; kick.textContent = "Your profile · last 14 days";
  const title = document.createElement("div"); title.className = "gx-title";
  title.textContent = myFollowers ? `${fmtCount(myFollowers)} followers${current.followerDelta != null ? ` · ${current.followerDelta >= 0 ? "+" : ""}${current.followerDelta}` : ""}` : "Growth tracking is warming up";
  const copy = document.createElement("div"); copy.className = "gx-copy";
  copy.textContent = "Goobi compares one strategic bet with the previous window. Profile clicks are not exposed, so follower and post changes are reported as co-movement, never attribution. Growth history stays local to this browser and X account.";
  const metrics = document.createElement("div"); metrics.className = "gx-metrics";
  const metric = (value: string, label: string, tip: string) => { const m = document.createElement("div"); m.className = "gx-metric"; m.title = tip; const b = document.createElement("b"); b.textContent = value; const s = document.createElement("span"); s.textContent = label; m.append(b, s); return m; };
  metrics.append(
    metric(current.followerDelta == null ? "—" : `${current.followerDelta >= 0 ? "+" : ""}${current.followerDelta}`, "followers", "First vs latest observed follower snapshot in this 14-day window."),
    metric(current.viewsPerPost == null ? "—" : fmtCount(Math.round(current.viewsPerPost))!, "views / post", `${current.measuredPosts} measured post${current.measuredPosts === 1 ? "" : "s"}; prior window ${prior.viewsPerPost == null ? "unavailable" : `~${fmtCount(Math.round(prior.viewsPerPost))}`}.`),
    metric(current.engagementPerPost == null ? "—" : current.engagementPerPost.toFixed(1), "eng / post", `${current.posts} post${current.posts === 1 ? "" : "s"} captured by their actual publish dates.`),
  );
  hero.append(kick, title, copy, metrics); wrap.append(hero);

  const bet = document.createElement("section"); bet.className = "gx-card";
  if (active) {
    const strategy = growthStrategy(active.strategyId);
    const elapsed = Math.max(1, Math.min(GROWTH_WINDOW_DAYS, Math.ceil((now - active.startedAt) / DAY_MS)));
    const evaluation = evaluateGrowthExperiment(growthStore, active, growthActions(), now);
    const head = document.createElement("div"); head.className = "gx-head";
    const h3 = document.createElement("h3"); h3.textContent = strategy.label;
    const day = document.createElement("span"); day.className = "gx-day"; day.textContent = `Day ${elapsed} / ${GROWTH_WINDOW_DAYS}`; head.append(h3, day);
    const hyp = document.createElement("div"); hyp.className = "gx-hyp"; hyp.textContent = strategy.hypothesis;
    const play = document.createElement("div"); play.className = "gx-play";
    [strategy.profileBrief, strategy.postBrief, strategy.replyBrief].forEach((line) => { const d = document.createElement("div"); d.textContent = line; play.append(d); });
    const read = document.createElement("div"); read.className = "gx-read";
    const rb = document.createElement("b"); rb.textContent = `${growthDecisionLabel(evaluation.decision)} · ${evaluation.headline}`; read.append(rb);
    const adherence = document.createElement("div"); adherence.textContent = `Execution recorded: ${evaluation.taggedPosts} on-strategy post${evaluation.taggedPosts === 1 ? "" : "s"} · ${evaluation.taggedReplies} confirmed repl${evaluation.taggedReplies === 1 ? "y" : "ies"}`; read.append(adherence);
    for (const reason of evaluation.reasons.filter((r) => !r.startsWith("Execution recorded:")).slice(0, 2)) { const d = document.createElement("div"); d.textContent = reason; read.append(d); }
    for (const signal of growthExecutionInsights(active.id, now)) { const d = document.createElement("div"); d.textContent = `Angle signal: ${signal}`; d.title = "Measured within this strategy window, shrunk and sample-gated. Correlation, not causation."; read.append(d); }
    const actions = document.createElement("div"); actions.className = "gx-actions";
    const endingEarly = now < active.endsAt;
    const endArmed = endingEarly && Date.now() < growthEndArmedUntil;
    const end = document.createElement("button"); end.className = "gx-btn secondary"; end.textContent = endingEarly ? (endArmed ? "End early?" : "End test") : "Review window";
    end.title = "Freeze this experiment's comparison. Early endings may stay 'keep collecting' when the sample is thin.";
    end.onclick = () => {
      if (endingEarly && Date.now() >= growthEndArmedUntil) {
        growthEndArmedUntil = Date.now() + 4_000;
        renderDock();
        window.setTimeout(() => { if (Date.now() >= growthEndArmedUntil && dockView === "growth") renderDock(); }, 4_100);
        return;
      }
      growthEndArmedUntil = 0;
      growthStore = finishGrowthExperiment(growthStore, active.id, growthActions(), Date.now());
      void persistGrowth(); renderDock();
    };
    const ideas = document.createElement("button"); ideas.className = "gx-btn"; ideas.textContent = "Make on-strategy ideas"; ideas.onclick = () => { dockView = "ideas"; renderDock(); };
    actions.append(end, ideas); bet.append(head, hyp, play, read, actions);
  } else {
    const recommended = recommendedGrowthStrategy(growthStore, profileNeedsWork);
    const chosen = growthStrategy(growthStrategyChoice ?? recommended.id);
    const head = document.createElement("div"); head.className = "gx-head";
    const h3 = document.createElement("h3"); h3.textContent = "Next 14-day bet";
    const rec = document.createElement("span"); rec.className = "gx-day"; rec.textContent = chosen.id === recommended.id ? "Recommended" : "Your choice"; head.append(h3, rec);
    const hyp = document.createElement("div"); hyp.className = "gx-hyp"; hyp.textContent = `${chosen.label}: ${chosen.hypothesis}`;
    const play = document.createElement("div"); play.className = "gx-play";
    [chosen.profileBrief, chosen.postBrief, chosen.replyBrief].forEach((line) => { const d = document.createElement("div"); d.textContent = line; play.append(d); });
    const actions = document.createElement("div"); actions.className = "gx-actions";
    const select = document.createElement("select"); select.className = "gx-select"; select.setAttribute("aria-label", "Growth strategy to test");
    for (const s of GROWTH_STRATEGIES) { const o = document.createElement("option"); o.value = s.id; o.textContent = s.label; o.selected = s.id === chosen.id; select.append(o); }
    select.onchange = () => { growthStrategyChoice = select.value as GrowthStrategyId; renderDock(); };
    const start = document.createElement("button"); start.className = "gx-btn"; start.textContent = "Start test";
    start.disabled = !!growthOwnerProblem || !growthStore.ownerHandle;
    start.title = start.disabled ? growthOwnerProblem || "Goobi needs your X account before it can save this test." : "Start this 14-day strategy test.";
    start.onclick = () => {
      captureGrowthData();
      const result = startGrowthExperiment(growthStore, chosen.id, Date.now());
      if (result.error) { toast(result.error); return; }
      growthStore = result.store; growthStrategyChoice = undefined; void persistGrowth(); renderDock();
    };
    actions.append(select, start); bet.append(head, hyp, play, actions);
    if (growthOwnerProblem) { const setup = document.createElement("div"); setup.className = "gx-find act"; setup.textContent = growthOwnerProblem; bet.append(setup); }
  }
  wrap.append(bet);

  const profile = document.createElement("section"); profile.className = "gx-card";
  const ph = document.createElement("div"); ph.className = "gx-head"; const ptitle = document.createElement("h3"); ptitle.textContent = "What makes the profile click";
  const open = document.createElement("button"); open.className = "gx-btn secondary"; open.textContent = "Open profile ↗"; open.onclick = () => { const h = growthStore.ownerHandle || selfHandle; if (h) window.open(`https://x.com/${h}`, "_blank", "noopener"); };
  ph.append(ptitle, open); profile.append(ph);
  const core = document.createElement("div"); core.className = "gx-copy"; core.textContent = "Specific competence earns curiosity. A clear promise, believable proof, and a strong pin give that curiosity a reason to follow."; profile.append(core);
  if (!currentProfileState) { const f = document.createElement("div"); f.className = "gx-find act"; f.textContent = "Visit your own X profile once so Goobi can inspect this account's conversion surface locally."; profile.append(f); }
  else if (!findings.length) { const f = document.createElement("div"); f.className = "gx-find good"; f.textContent = "No measurable profile blocker found. Test the content promise next."; profile.append(f); }
  else for (const finding of findings.slice(0, 3)) { const f = document.createElement("div"); f.className = `gx-find ${finding.level}`; f.textContent = `${finding.level === "good" ? "✓" : "→"} ${finding.text}`; f.title = finding.why; profile.append(f); }
  wrap.append(profile);

  const history = growthStore.experiments.filter((e) => e.status === "completed").slice(0, 3);
  if (history.length) {
    const card = document.createElement("section"); card.className = "gx-card";
    const h = document.createElement("div"); h.className = "gx-head"; const ht = document.createElement("h3"); ht.textContent = "What Goobi learned"; h.append(ht); card.append(h);
    const rows = document.createElement("div"); rows.className = "gx-history";
    for (const exp of history) {
      const row = document.createElement("div"); row.className = "gx-hrow"; row.tabIndex = 0;
      const top = document.createElement("div"); top.className = "gx-hmain";
      const s = document.createElement("b"); s.textContent = growthStrategy(exp.strategyId).label;
      const result = document.createElement("span"); result.textContent = exp.outcome ? growthDecisionLabel(exp.outcome.decision) : "Not enough data"; top.append(s, result);
      const meta = document.createElement("div"); meta.className = "gx-hmeta";
      const ended = exp.endedAt ?? exp.endsAt;
      const evidence = exp.outcome ? `${exp.outcome.taggedPosts} posts · ${exp.outcome.taggedReplies} replies` : "No settled evidence";
      meta.textContent = `${new Date(exp.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}–${new Date(ended).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${evidence}${exp.outcome?.reasons[0] ? ` · ${exp.outcome.reasons[0]}` : ""}`;
      row.title = [...(exp.outcome?.reasons ?? []), ...growthExecutionInsights(exp.id, ended)].join(" · ") || "The window ended before a comparable result settled.";
      row.setAttribute("aria-label", `${s.textContent}: ${result.textContent}. ${meta.textContent}`);
      row.append(top, meta); rows.append(row);
    }
    card.append(rows); wrap.append(card);
  }
  return wrap;
}

function renderDock() {
  if (!enabled || invalidated) return;
  if (dockPlayOpen && dockRoot?.querySelector(".dplay")) return; // playground is live — ambient re-renders must not tear it down under the user
  const root = ensureDock();
  // Preserve the reply-list scroll across the full rebuild (ambient renders — reach completions,
  // timers, cross-tab syncs — otherwise snap it back to the top). Restored in a microtask, after
  // this synchronous rebuild appends the new list, before paint (no flicker). No-op on the pill.
  const prevScroll = (root.querySelector(".dl") as HTMLElement | null)?.scrollTop ?? 0;
  if (prevScroll > 0) queueMicrotask(() => { if (!invalidated) { const dl = root.querySelector(".dl") as HTMLElement | null; if (dl) dl.scrollTop = prevScroll; } });
  goobiDockHandle?.destroy(); goobiDockHandle = null; // stop the previous header Goobi before we rebuild (replaceChildren only detaches it)
  stopIdeasGoobi(); // the ideas-loading dancer (re-mounted below if still loading)
  root.replaceChildren();
  const n = opps.size;
  if (!dockOpen) {
    const { mood, line, sub } = goobiStatus();
    const l = document.createElement("div"); l.className = "l"; l.setAttribute("role", "button"); // div, not button — the pill hosts nested control buttons
    l.tabIndex = 0; // keep keyboard access (it was a <button> before the nested controls)
    l.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); l.click(); } };
    l.title = `${line} — open Goobi`;
    l.onclick = () => {
      dockOpen = true;
      if (dockPlayOpen) resetPlay(); // always open onto the posts list, never a stale playground
      if (goobiWelcomeBack) { goobiWelcomeBack = false; goobiReact("cheer", "Missed you!", "glad you're back", 4000); }
      touchGoobi();
      // refreshOwnStats owns the single from:<handle> fetch; run it FIRST so the daily learn
      // pass reads a warm cache (no double-bill), then the once-a-day trend + measure-pass.
      void refreshOwnStats().catch(() => {}).then(() => { if (!invalidated) void maybeRunDailyLearn(); });
      void ensureTargetOwner(); // reset the target list if the account changed
      void ensureDmOwner(); // load the signed-in account's isolated DM workspace
      void ensureGrowthOwner(); // refresh account-level experiment snapshots + settle due windows
      renderDock();
    };
    const gh = document.createElement("span"); gh.className = "lgoobi"; l.append(gh); // Goobi IS the launcher icon
    const txt = document.createElement("span"); txt.className = "ltext";
    const l1 = document.createElement("span"); l1.className = "ll1"; l1.textContent = n ? `${n} reply ${n === 1 ? "spot" : "spots"}` : "Goobi";
    txt.append(l1);
    const summary = n ? catSummary() : sub;
    if (summary) { const l2 = document.createElement("span"); l2.className = "ll2"; l2.textContent = summary; txt.append(l2); }
    l.append(txt);
    if (n) { const avs = launcherAvatars(); if (avs) l.append(avs); } // overlapping faces of who to reply to
    // Minimized controls: pause/resume + manual search, without expanding the dock.
    const ctl = document.createElement("span"); ctl.className = "lctl";
    const pb = document.createElement("button"); pb.className = "lbtn";
    pb.textContent = paused ? "▶" : "⏸";
    pb.title = paused ? "Resume — start finding reply spots again" : "Pause — no scanning, surfacing, or API calls";
    pb.setAttribute("aria-label", paused ? "Resume the copilot" : "Pause the copilot"); // icon glyphs read poorly in screen readers
    pb.onclick = (e) => { e.stopPropagation(); setPaused(!paused); };
    const sb = document.createElement("button"); sb.className = "lbtn"; sb.textContent = "✦";
    sb.setAttribute("aria-label", "Find reply spots in your niche");
    sb.disabled = paused || findingSpots;
    sb.title = paused ? "Paused — resume to search" : findingSpots ? "Searching…" : "Find spots — search X for fresh posts in your niche";
    sb.onclick = (e) => { e.stopPropagation(); void findSpots(); };
    const rb = document.createElement("button"); rb.className = "lbtn"; rb.textContent = "⚡";
    rb.setAttribute("aria-label", "Find measured breakout and major-account early reply openings");
    rb.disabled = paused || findingSpots || !myFollowers;
    rb.title = paused ? "Paused — resume to search" : !myFollowers ? "Set your X handle first" : findingSpots ? "Searching…" : "Fresh Reach — find proven breakout distribution and unusually early openings on practical or massive accounts";
    rb.onclick = (e) => { e.stopPropagation(); void findSpots("fresh-reach"); };
    ctl.append(pb, sb, rb); l.append(ctl);
    root.appendChild(l);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(mood);
    return;
  }
  const d = document.createElement("div"); d.className = "d" + (dockView === "comments" || dockView === "ideas" || dockView === "targets" || dockView === "dms" || dockView === "growth" ? " wide" : "");
  const gstat = goobiStatus();
  const gh = document.createElement("div"); gh.className = "dhgoobi"; gh.title = `${gstat.line} — tap Goobi to play`; gh.setAttribute("role", "button"); gh.tabIndex = 0; gh.setAttribute("aria-label", `${gstat.line}. Open Goobi's playground`); gh.onclick = () => togglePlay();
  gh.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePlay(); } };
  const h = document.createElement("div"); h.className = "dh";
  const t = document.createElement("div"); t.className = "dt";
  const today = repliesToday();
  const now = Date.now();
  const commentQueue = rankThreads(inbound as InboundLite[], replyLog.sent, now, 20, completedThreadIds());
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const verifiedToday = replyVerificationSummary(replyLog.sent, startToday.getTime(), now);
  const title = document.createElement("div"); title.className = "dtitle";
  title.textContent = dockView === "replies" ? `${n} reply ${n === 1 ? "spot" : "spots"}` : dockView === "comments" ? "Comments to reply to" : dockView === "ideas" ? "Post ideas" : dockView === "targets" ? "Target accounts" : dockView === "dms" ? "DM workspace" : "Growth loop";
  const sub = document.createElement("div"); sub.className = "dsub";
  const cnt = document.createElement("span");
  cnt.textContent = today > 0
    ? `${verifiedToday.confirmed} verified${verifiedToday.pending ? ` · ${verifiedToday.pending} pending` : ""}`
    : "0 today";
  cnt.title = `${verifiedToday.confirmed} actual ${verifiedToday.confirmed === 1 ? "reply" : "replies"} matched through RapidAPI or manually confirmed today; ${verifiedToday.pending} successful Like + insert ${verifiedToday.pending === 1 ? "attempt is" : "attempts are"} awaiting a match. Copy/open drafts do not count until manually confirmed.`;
  // Live pace chip — surfaces the account-safety status in the moment you're replying.
  const stt = currentReplyPace(now);
  const rhh = stt.repliesThisHour;
  const PACE_COLOR: Record<string, string> = { healthy: "#6fcf7f", caution: "#e89a3c", easeoff: "#d6604a" };
  const chip = document.createElement("span"); chip.className = "pace";
  if (paused) { chip.textContent = "Paused"; chip.style.color = "#8c7d68"; chip.title = "The copilot is paused — no scanning, surfacing, or API calls."; }
  else {
    chip.style.color = PACE_COLOR[stt.level]; chip.textContent = stt.label;
    chip.title = `${rhh} ${rhh === 1 ? "reply" : "replies"} recorded this hour · ${stt.pressure.toFixed(1)}/${REPLY_PACE_EASEOFF} adaptive pressure. Warm inbound/ongoing conversations count less, and activity fades after 15 minutes. This is Goobi's local heuristic—not an X limit.${stt.resetAt ? " The local baseline was manually reset; X activity and limits were not." : ""}`;
  }
  if (dockView === "dms") {
    const dmPace = dmPacingStatus(dmStore, now);
    chip.style.color = dmPace.level === "pause" ? "#d6604a" : dmPace.level === "caution" ? "#e89a3c" : "#6fcf7f";
    chip.textContent = dmPace.level === "pause" ? "DM pause" : dmPace.level === "caution" ? "DM caution" : "Thoughtful pace";
    chip.title = `${dmPace.firstHour} first DMs marked this hour; ${dmPace.firstDay} first and ${dmPace.totalDay} total marked today.`;
    cnt.textContent = `${dueFollowUps(dmStore, now).length} due · ${dmStore.candidates.filter((c) => !c.removedAt).length} people`;
    cnt.title = "DM state is based on actions you mark manually; Goobi cannot verify delivery, reads, or replies.";
  }
  if (dockView === "comments") {
    chip.style.color = commentQueue.untended ? "#6fcf7f" : "#8c7d68";
    chip.textContent = commentQueue.untended ? "Warm first" : "Caught up";
    chip.title = "Recent replies and mentions from the X notifications page, freshest first.";
    cnt.textContent = `${commentQueue.untended} open · ${commentQueue.total} recent`;
    cnt.title = "Open excludes rows Goobi can exactly match to a reply or softly identifies as likely tended. Notifications are a recent sample, not a complete inbox.";
  }
  if (dockView === "growth") {
    const gx = activeGrowthExperiment(growthStore);
    chip.style.color = gx ? "#e89a3c" : "#8c7d68"; chip.textContent = gx ? "Experiment live" : "Ready to test";
    chip.title = gx ? `${growthStrategy(gx.strategyId).label}, day ${Math.max(1, Math.ceil((now - gx.startedAt) / DAY_MS))} of ${GROWTH_WINDOW_DAYS}.` : "Choose one reason to follow and hold it long enough to compare with the prior window.";
    const recent = summarizeGrowthWindow(growthStore, now - GROWTH_WINDOW_DAYS * DAY_MS, now);
    cnt.textContent = recent.followerDelta == null ? "collecting baseline" : `${recent.followerDelta >= 0 ? "+" : ""}${recent.followerDelta} followers · 14d`;
    cnt.title = "Follower change between the first and latest observed snapshots in the last 14 days. Profile clicks are unavailable, so this is not attributed to Goobi.";
  }
  sub.append(chip, document.createTextNode(" · "), cnt);
  if (dockView === "replies") {
    sub.setAttribute("role", "button"); sub.tabIndex = 0; sub.setAttribute("aria-expanded", String(todayOpen));
    sub.title += todayOpen ? " Hide pace details." : " Show pace details.";
    const toggleHealth = () => { todayOpen = !todayOpen; renderDock(); };
    sub.onclick = toggleHealth; sub.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleHealth(); } };
  }
  t.append(title, sub);
  const dhl = document.createElement("div"); dhl.className = "dhl"; dhl.append(gh, t); // Goobi sits left of the title

  const acts = document.createElement("div"); acts.className = "da";
  const kb = document.createElement("button"); kb.className = "iconb"; kb.textContent = "⋮"; kb.title = "More — pause, rescan, reset local pace, clear"; kb.setAttribute("aria-label", "More actions");
  kb.onclick = () => { kebabOpen = !kebabOpen; renderDock(); };
  acts.append(kb);
  const x = document.createElement("button"); x.className = "iconb"; x.textContent = "–"; x.title = "Minimize"; x.setAttribute("aria-label", "Minimize the dock"); // collapses to the launcher pill — it minimizes, it doesn't close
  x.onclick = () => { kebabOpen = false; if (dockPlayOpen) resetPlay(); dockOpen = false; renderDock(); };
  acts.append(x);
  h.append(dhl, acts);
  d.append(h);

  if (!paused && !dockPlayOpen && dockView === "replies") {
    const discovery = document.createElement("div"); discovery.className = "discovery"; discovery.setAttribute("aria-label", "Find reply opportunities");
    const find = document.createElement("button"); find.className = "findb secondary"; find.textContent = findingSpots ? "Searching…" : "✦ Find spots";
    find.title = xNiche.trim() ? "Search X for fresh posts in your niche" : "Set your niche in the Goobi panel first";
    find.disabled = findingSpots || !xNiche.trim();
    find.onclick = () => void findSpots();
    const reach = document.createElement("button"); reach.className = "findb"; reach.textContent = findingSpots ? "Searching…" : "⚡ Fresh reach";
    reach.title = !myFollowers ? "Set your X handle first so Goobi can compare account size" : "Use focused and broad Top results to find proven distribution, then scan practical and massive accounts for breakout or unusually early openings";
    reach.disabled = findingSpots || !xNiche.trim() || !myFollowers;
    reach.onclick = () => void findSpots("fresh-reach");
    discovery.append(find, reach);
    if (lastFreshReachRun) {
      const receipt = document.createElement("div"); receipt.className = "fresh-receipt";
      const lead = document.createElement("strong"); lead.textContent = lastFreshReachRun.state === "searching" ? "⚡ Hunting now" : lastFreshReachRun.state === "failed" ? "⚡ Hunt paused" : "⚡ Last hunt";
      const detail = document.createElement("span");
      detail.textContent = lastFreshReachRun.state === "searching"
        ? " · building the account pool and checking fresh originals"
        : lastFreshReachRun.state === "failed"
          ? ` · ${lastFreshReachRun.note || "the search did not complete"}`
          : ` · discovered ${lastFreshReachRun.accountsDiscovered} new ${lastFreshReachRun.accountsDiscovered === 1 ? "account" : "accounts"} · radar ${lastFreshReachRun.radarSize}${lastFreshReachRun.massiveSaved ? ` (${lastFreshReachRun.massiveSaved} massive)` : ""} · keep-list ${lastFreshReachRun.shortlistSize} · scanned ${lastFreshReachRun.accountsChecked}${lastFreshReachRun.massiveChecked ? ` (${lastFreshReachRun.massiveChecked} massive${lastFreshReachRun.watchlistChecked ? `, ${lastFreshReachRun.watchlistChecked} pinned` : ""}${lastFreshReachRun.shortlistChecked ? `, ${lastFreshReachRun.shortlistChecked} winner` : ""})` : ""} · ${lastFreshReachRun.originals} originals · ${lastFreshReachRun.breakoutCandidates} breakout pace · ${lastFreshReachRun.majorCandidates} major + early · ${lastFreshReachRun.eligible} live matches · ${lastFreshReachRun.added} strong ${lastFreshReachRun.added === 1 ? "opening" : "openings"}${lastFreshReachRun.addedBreakouts ? ` (${lastFreshReachRun.addedBreakouts} breakout)` : ""}${lastFreshReachRun.addedMajor ? ` (${lastFreshReachRun.addedMajor} major)` : ""}${lastFreshReachRun.bestOpening ? ` · top ${freshReachOpeningBand(lastFreshReachRun.bestOpening)}` : ""}${lastFreshReachRun.budgetLimited ? " · budget limited" : ""}`;
      receipt.append(lead, detail); discovery.append(receipt);
    }
    d.append(discovery);
  }

  // One dominant workspace switcher sits directly under the header. Everything
  // else is contextual to the selected workspace.
  const modes = document.createElement("div"); modes.className = "modes"; modes.setAttribute("role", "tablist"); modes.setAttribute("aria-label", "Goobi workspace");
  const mkMode = (id: DockView, label: string, count?: number) => {
    const selected = dockView === id || (id === "replies" && dockView === "targets");
    const b = document.createElement("button"); b.className = "mode" + (selected ? " on" : "");
    const l = document.createElement("span"); l.textContent = label; b.append(l);
    if (count != null && count > 0) { const badge = document.createElement("span"); badge.className = "mode-count"; badge.textContent = String(count); b.append(badge); }
    b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(selected));
    b.onclick = () => { if (dockView !== id) { dockView = id; relationshipsOpen = false; replyToolsOpen = false; renderDock(); } };
    return b;
  };
  modes.append(mkMode("replies", "Replies", n), mkMode("comments", "Comments", commentQueue.untended), mkMode("ideas", "Post ideas"), mkMode("dms", "DMs", dueFollowUps(dmStore, Date.now()).length), mkMode("growth", "Growth"));
  d.append(modes);
  const postProgress = Math.max(postedToday(), ownStats !== undefined ? ownViewsToday().posts : 0);
  d.append(dailyGoalTracker({ replies: verifiedToday.confirmed + verifiedToday.pending, posts: postProgress, dms: dmPeopleToday() }));

  // Today strip — the same data the old six-line stack showed, TIERED so it stops burying the work
  // queue: one compact summary row (momentum bar + state + today's facts), ONE "next best move"
  // coach line, and the full detail (cue / shape / activity dots / callout, tooltips intact) behind
  // a caret. The coach slot has a deterministic priority and SAFETY ALWAYS WINS it — at ease-off or
  // caution the safety message owns the line, so the honesty keystone is front and center even
  // collapsed (the pace chip + red state label agree with it, same stt).
  if (dockView === "replies" && todayOpen) {
    const lastReply = replyLog.times.length ? Math.max(...replyLog.times) : 0;
    const lastPost = ideaQueue.reduce((mx, i) => (i.postedAt && i.postedAt > mx ? i.postedAt : mx), 0);
    const lastAt = Math.max(lastReply, lastPost);
    const m = computeMomentum({
      repliesToday: repliesToday(), postedToday: postedToday(), replyStreak: replyStreak(),
      minsSinceLast: lastAt ? (Date.now() - lastAt) / 60000 : 9999, repLevel: stt.level,
    });
    const ds = dailyShape({ repliesToday: repliesToday(), postedToday: postedToday(), repLevel: stt.level });
    const dsTitle = "The shape we coach for a growth day: replies to earn reach, plus a spaced original to convert profile clicks into follows. That chain is a prior, not proven — the measured loop is checking whether it works on YOUR account. Same-load posts may attenuate each other, so space originals.";
    const postsByDay: Record<string, number> = {};
    for (const [k, sn] of Object.entries(learn.snaps)) postsByDay[k] = sn.posts;
    const cells = activityCells(replyLog.daily, postsByDay, Date.now(), dayKey, 14);
    const ch = chain(cells);
    let postsThisWeek = 0; for (const c of cells.slice(-7)) postsThisWeek += c.posts;
    const co = pickCallout({ easeoff: stt.level === "easeoff", trend: accountTrend(learn.snaps, Date.now())?.state ?? null, chainDays: ch.current, repliesToday: repliesToday(), postsThisWeek, freeTier: premiumTier === "free" });
    const coText = (co.kind === "measured" ? "✓ " : "✦ ") + co.text;
    const coTitle = co.why + (co.kind === "measured" ? " — measured on your own data." : " — an algo prior (directional; the live ranker is undisclosed).");
    const chainTitle = `Consecutive days with a Goobi reply or a shipped post (best in this window: ${ch.best}). Measured activity. X has no literal streak bonus — consistency pays through repeat engagement (affinity) and account reputation, which is exactly what a gap decays.`;

    const mom = document.createElement("div"); mom.className = "mom";

    // Row 1 — summary: [mini bar][state] · posts/views · chain … caret. Click/Enter toggles detail.
    const sum = document.createElement("div"); sum.className = "mom-sum";
    sum.setAttribute("role", "button"); sum.tabIndex = 0;
    sum.setAttribute("aria-expanded", String(todayOpen));
    sum.title = todayOpen ? "Hide today's detail" : "Show today's detail — momentum cue, daily shape, 14-day activity, and the algo callout";
    const toggleToday = () => { todayOpen = !todayOpen; renderDock(); };
    sum.onclick = toggleToday;
    sum.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleToday(); } };
    const bar = document.createElement("div"); bar.className = "mom-bar"; // full-width progress bar spanning the strip
    const fill = document.createElement("div"); fill.className = "mom-fill"; fill.style.width = m.score + "%"; fill.style.background = m.color;
    if (m.state === "peak") fill.style.boxShadow = `0 0 8px ${m.color}`;
    bar.append(fill);
    const lbl = document.createElement("span"); lbl.className = "mom-label"; lbl.textContent = m.label; lbl.style.color = m.color;
    const bits = document.createElement("span"); bits.className = "mom-bits";
    if (ownStats !== undefined) {
      const v = ownViewsToday();
      const stat = document.createElement("span");
      stat.textContent = "· " + (v.posts ? `${v.posts} post${v.posts === 1 ? "" : "s"}${v.hasViews ? ` · ${fmtCount(v.views)} views` : ""}` : "no posts yet");
      stat.title = "X-reported views on the posts you've shipped today, pulled from the X-data API. Refreshed on dock open (~hourly), not live.";
      bits.append(stat);
    }
    const chainEl = document.createElement("span");
    chainEl.textContent = "· " + (stt.level === "easeoff" ? `⏸ ${ch.current}d chain` : ch.current >= 2 ? `🔥 ${ch.current}d chain` : ch.current === 1 ? "1 active day" : "start a chain");
    chainEl.title = chainTitle;
    bits.append(chainEl);
    const car = document.createElement("span"); car.className = "mom-car"; car.textContent = todayOpen ? "▾" : "▸";
    const meta = document.createElement("div"); meta.className = "mom-meta"; meta.append(lbl, bits, car); // label + facts sit BELOW the full-width bar
    sum.append(bar, meta);
    mom.append(sum);
    // The epistemic key, always visible (the ✓/✦ convention was hover-only — the whole honesty
    // thesis was invisible). One muted line, zero layout cost.
    const legend = document.createElement("div");
    legend.textContent = "✓ measured on your data · ✦ algo prior";
    legend.title = "Every number and coach line carries one of these: ✓ = computed from your own logged replies/outcomes; ✦ = a directional prior from X's open-sourced ranking code (the live weights are private).";
    Object.assign(legend.style, { font: "500 9.5px -apple-system, system-ui, sans-serif", color: "#a89a85", margin: "2px 2px 0", letterSpacing: ".02em" } as Partial<CSSStyleDeclaration>);
    mom.append(legend);

    // Row 2 — the ONE coach line. Priority: safety (ease-off callout / caution cue) → daily shape
    // (the actionable next move) → the algo/measured callout. Never empty; a bare affirmation only
    // when nothing actionable exists.
    let coachSrc: "callout" | "cue" | "shape";
    const coach = document.createElement("div"); coach.className = "mom-coach";
    if (stt.level === "easeoff") { coachSrc = "callout"; coach.textContent = coText; coach.title = coTitle; coach.classList.add("warn"); }
    else if (stt.level === "caution") { coachSrc = "cue"; coach.textContent = m.cue; coach.classList.add("amber"); }
    else if (ds) { coachSrc = "shape"; coach.textContent = "◆ " + ds.text; coach.title = dsTitle; }
    else { coachSrc = "callout"; coach.textContent = coText; coach.title = coTitle; }
    mom.append(coach);

    // Expanded detail — everything the strip used to stack (minus the line already in the coach
    // slot): momentum cue, daily shape, the 14-day dots + full chain, and the callout. Every
    // dot/number stays measured and every tooltip keeps its evidence class (honesty intact).
    if (todayOpen) {
      const det = document.createElement("div"); det.className = "mom-detail";
      if (coachSrc !== "cue") { const cue = document.createElement("div"); cue.className = "mom-cue"; cue.textContent = m.cue; det.append(cue); }
      if (ds && coachSrc !== "shape") { const dl = document.createElement("div"); dl.className = "mom-cue"; dl.textContent = "◆ " + ds.text; dl.title = dsTitle; det.append(dl); }
      const shades = ["rgba(214,154,92,.15)", "rgba(232,154,60,.4)", "rgba(232,154,60,.7)", "#e89a3c"];
      const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:7px";
      const dots = document.createElement("div"); dots.style.cssText = "display:flex;gap:3px;align-items:center"; dots.setAttribute("aria-hidden", "true"); // decorative — the chain label + per-dot titles carry the data
      cells.forEach((c, i) => {
        const dot = document.createElement("span");
        dot.style.cssText = `width:7px;height:7px;border-radius:2px;background:${shades[c.intensity]}` + (i === cells.length - 1 ? ";box-shadow:0 0 0 1px rgba(232,154,60,.5)" : "");
        dot.title = `${c.day} — ${c.replies} ${c.replies === 1 ? "reply" : "replies"} · ${c.posts} ${c.posts === 1 ? "post" : "posts"} (measured: sent through Goobi)`;
        dots.append(dot);
      });
      const chainFull = document.createElement("span");
      chainFull.style.cssText = "font:600 11px -apple-system,system-ui,sans-serif;color:#8c7d68;white-space:nowrap";
      chainFull.textContent = stt.level === "easeoff" ? `⏸ ${ch.current}-day chain` : ch.current >= 2 ? `🔥 ${ch.current}-day chain` : ch.current === 1 ? "1 active day" : "start a chain";
      chainFull.title = chainTitle;
      row.append(dots, chainFull);
      det.append(row);
      if (coachSrc !== "callout") { const coEl = document.createElement("div"); coEl.className = "mom-cue"; coEl.textContent = coText; coEl.title = coTitle; det.append(coEl); }
      mom.append(det);
    }
    d.append(mom);
  }

  // ⋮ overflow menu + click-away backdrop.
  if (kebabOpen) {
    const back = document.createElement("div"); back.className = "kback"; back.onclick = () => { kebabOpen = false; renderDock(); };
    const menu = document.createElement("div"); menu.className = "kmenu";
    const item = (label: string, fn: () => void, disabled = false) => {
      const b = document.createElement("button"); b.className = "kitem"; b.textContent = label; b.disabled = disabled;
      b.onclick = () => { kebabOpen = false; renderDock(); fn(); };
      menu.append(b);
    };
    item(paused ? "▶ Resume" : "⏸ Pause", () => setPaused(!paused));
    if (!paused && dockView === "replies") item("↻ Rescan this page", () => rescan());
    if (dockView === "replies" && (stt.repliesThisHour > 0 || stt.resetAt)) item("↺ Reset local pace meter", resetReplyPace);
    if (n) item("🗑 Clear all", () => { opps.clear(); toast("Cleared all reply spots."); renderDock(); });
    d.append(back, menu);
  }

  if (paused) {
    const p = document.createElement("div"); p.className = "paused";
    const pt = document.createElement("div"); pt.className = "pttl"; pt.textContent = "⏸ Paused";
    const pp = document.createElement("div"); pp.className = "pcopy"; pp.textContent = "The copilot is quiet — no scanning, no surfacing, no API calls. Take your break; your posts come back when you resume.";
    const rb = document.createElement("button"); rb.className = "draftb"; rb.style.width = "auto"; rb.style.padding = "9px 22px"; rb.textContent = "Resume"; rb.onclick = () => setPaused(false);
    p.append(pt, pp, rb);
    d.append(p);
    root.appendChild(d);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood("sleeping"); // resting while paused
    return;
  }

  // Goobi's playground — tap him to expand it in place of the post list.
  if (dockPlayOpen) {
    const play = buildPlay();
    d.append(play);
    root.appendChild(d);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(gstat.mood);
    const stage = play.querySelector<HTMLElement>(".dpg-stage");
    if (stage) { goobiPlayHandle?.destroy(); goobiPlayHandle = mountGoobi(stage, { cell: 4, playful: true }); goobiPlayHandle.setMood(playReady() ? "cheer" : "idle"); }
    syncPlay();
    return;
  }

  if (dockView === "growth") {
    d.append(buildGrowth());
    root.appendChild(d);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(gstat.mood);
    return;
  }

  if (dockView === "comments") {
    d.append(buildComments());
    root.appendChild(d);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(gstat.mood);
    return;
  }

  if (dockView === "ideas") {
    d.append(buildIdeas());
    root.appendChild(d);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(gstat.mood);
    mountIdeasGoobi(); // dance while ideas generate (after the dock is in the DOM)
    return;
  }
  if (dockView === "targets") {
    d.append(buildTargets());
    root.appendChild(d);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(gstat.mood);
    return;
  }
  if (dockView === "dms") {
    d.append(buildDms());
    root.appendChild(d);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(gstat.mood);
    return;
  }

  // Relationship drill-in replaces the queue and its tools instead of competing with them.
  if (relationshipsOpen) {
    renderRelationshipTabs(d);
    root.appendChild(d);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(gstat.mood);
    return;
  }

  // Contextual reply tools: the queue gets the space; sort/filter expand only on request.
  const toolrow = document.createElement("div"); toolrow.className = "reply-tools";
  const toolLabel = document.createElement("span"); toolLabel.className = "reply-tools-label"; toolLabel.textContent = n ? "Reply queue" : "Watching for reply spots";
  const toolButton = document.createElement("button"); toolButton.className = "reply-tools-btn";
  const sortNames: Record<DockSort, string> = { best: "Best fit", recent: "Recent", reach: "Reach opportunity", easy: "Easy replies" };
  toolButton.textContent = `${sortNames[dockSort]}${dockFilter ? " · filtered" : ""} ${replyToolsOpen ? "▴" : "▾"}`;
  toolButton.setAttribute("aria-expanded", String(replyToolsOpen));
  toolButton.onclick = () => { replyToolsOpen = !replyToolsOpen; renderDock(); };
  const secondary = document.createElement("div"); secondary.style.cssText = "display:flex;gap:6px;align-items:center";
  const targets = document.createElement("button"); targets.className = "reply-tools-btn"; targets.textContent = "Find people";
  targets.title = "Secondary discovery: track larger relevant accounts after warm comments and strong reply spots are handled.";
  targets.onclick = () => { dockView = "targets"; renderDock(); };
  secondary.append(targets, toolButton); toolrow.append(toolLabel, secondary); d.append(toolrow);

  const tabs = document.createElement("div"); tabs.className = "tabs"; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Sort reply spots");
  const TABS: { id: DockSort; label: string; title: string }[] = [
    { id: "best", label: "Best", title: "Best reply-fit first" },
    { id: "recent", label: "Recent", title: "Newest posts first" },
    { id: "reach", label: "Reach", title: "Best observed reach opening first—not simply the biggest account" },
    { id: "easy", label: "Easy replies", title: "Short, answerable posts you can reply to fast and early" },
  ];
  for (const td of TABS) {
    const tb2 = document.createElement("button"); tb2.className = "tab" + (dockSort === td.id ? " on" : ""); tb2.textContent = td.label; tb2.title = td.title;
    tb2.setAttribute("role", "tab"); tb2.setAttribute("aria-selected", String(dockSort === td.id));
    tb2.onclick = () => { if (dockSort !== td.id) { dockSort = td.id; renderDock(); } };
    tabs.append(tb2);
  }
  const f = document.createElement("input"); f.className = "df"; f.placeholder = "Search these reply spots…"; f.setAttribute("aria-label", "Search reply spots"); f.value = dockFilter;
  const list = document.createElement("div"); list.className = "dl";
  f.oninput = () => { dockFilter = f.value; renderList(list); };
  if (replyToolsOpen) d.append(tabs, f);
  d.append(list);
  renderRelationshipTabs(d); // collapsed summary after the work queue

  const foot = document.createElement("div"); foot.className = "foot";
  const f1 = document.createElement("div"); f1.className = "foot1";
  const f2 = document.createElement("div"); f2.className = "foot2";
  if (!n) { // no spots surfaced — the genuine "nothing to do" / watching state
    f1.textContent = "✦ You're all caught up";
    f2.textContent = "New reply spots appear as you scroll. Search your niche, or hunt fresh posts from larger reachable accounts.";
    const find = document.createElement("button"); find.className = "findb"; find.textContent = findingSpots ? "Searching X…" : "Find spots in my niche";
    find.disabled = findingSpots || !xNiche.trim(); find.title = xNiche.trim() ? "Search X for fresh, high-fit reply spots" : "Set your niche in the Goobi panel first";
    find.onclick = () => void findSpots();
    const reach = document.createElement("button"); reach.className = "findb"; reach.textContent = "⚡ Fresh reach";
    reach.disabled = findingSpots || !xNiche.trim() || !myFollowers;
    reach.title = !myFollowers ? "Set your X handle first" : "Measure proven breakout distribution and scan practical plus massive accounts for unusually early openings";
    reach.onclick = () => void findSpots("fresh-reach");
    foot.append(f1, f2, find, reach); d.append(foot);
  }

  root.appendChild(d);
  renderList(list);
  goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(gstat.mood); // Goobi lives at the top, mood-driven
}

/* ---------- dev-only learning-data export (for the offline backtest) ---------- */

/** Snapshot the learning data + a size summary. `settledN` (outcomes frozen at
 *  SETTLE_DAYS) is the honest power check — how many replies have a FINAL measured
 *  outcome the backtest can trust. `measuredN` includes still-provisional ones. */
function buildLearnExport(): unknown {
  const sent = replyLog.sent || [];
  const measuredN = sent.filter((r) => r.outcome && (r.outcome.likes != null || r.outcome.replies != null)).length;
  const settledN = sent.filter((r) => r.outcome?.frozen).length;
  return { replyLog, learn, growth: growthStore, meta: { exportedAt: Date.now(), handle: learn?.handle || selfHandle || "", n: sent.length, measuredN, settledN } };
}

/** Expose window.__goobiExport() when the debug flag is on (dev only). Returns the
 *  data object (so DevTools `copy(__goobiExport())` works), also writes it to the
 *  clipboard and logs the JSON string as a fallback copy path. No product effect. */
function installDebugHook(): void {
  const w = window as unknown as { __goobiExport?: () => unknown };
  if (!debugOn) { try { delete w.__goobiExport; } catch { /* ignore */ } return; }
  w.__goobiExport = () => {
    const data = buildLearnExport();
    const json = JSON.stringify(data);
    const m = (data as { meta: { n: number; measuredN: number; settledN: number } }).meta;
    try { void navigator.clipboard.writeText(json).then(() => toast("Learning data copied to clipboard."), () => { /* no gesture — use the logged string */ }); } catch { /* ignore */ }
    console.log(`[goobi] learning export — n=${m.n} measured=${m.measuredN} settled=${m.settledN}. copy(__goobiExport()) to copy, or grab the string:\n`, json);
    return data;
  };
  console.log("[goobi] debug on — run __goobiExport() in THIS console (content-script context) to dump learning data for the backtest.");
}

/* ---------- boot + SPA route handling ---------- */

async function boot() {
  void maybeFulfillReplyHandoff(); // a user-started handoff does not depend on re-running Claude or the dock setup path
  const xDataConsent = (await getLocal(CONFIG.X_DATA_CONSENT_KEY)) === "v1";
  const hasAnthropicKey = Boolean(await getLocal(CONFIG.ANTHROPIC_KEY_KEY));
  const requestedOn = (await getLocal(CONFIG.X_COPILOT_KEY)) !== false;
  if (!requestedOn) return;
  if (!xDataConsent || !hasAnthropicKey) {
    renderSetupGate(!xDataConsent ? "Review data use in the side panel" : "Add your Anthropic key in the side panel");
    watchSetupGate();
    return;
  }
  enabled = true;
  paused = (await getLocal(CONFIG.X_PAUSED_KEY)) === true; // default not paused
  const storedProducts = await getLocal(CONFIG.X_PRODUCTS_KEY);
  xProducts = Array.isArray(storedProducts) ? (storedProducts as ProductItem[]) : [];
  legacyProduct = ((await getLocal(CONFIG.X_PRODUCT_KEY)) as string) || "";
  xDefaultAngle = ((await getLocal(CONFIG.X_DEFAULT_ANGLE_KEY)) as string) || "";
  xDefaultProduct = ((await getLocal(CONFIG.X_DEFAULT_PRODUCT_KEY)) as string) || "";
  xReplyInsertOn = (await getLocal(CONFIG.X_REPLY_INSERT_KEY)) === true; // absent = safe manual handoff; true preserves explicit legacy opt-in
  learnLoopOn = (await getLocal(CONFIG.X_LEARN_LOOP_KEY)) === true; // default OFF — enable only after the real-data backtest validates the learned signal
  debugOn = (await getLocal(CONFIG.X_DEBUG_KEY)) === true;
  installDebugHook(); // dev-only window.__goobiExport() when debugOn (no-op otherwise)
  xNiche = ((await getLocal(CONFIG.X_NICHE_KEY)) as string) || "";
  dailyGoals = normalizeDailyGoals(await getLocal(CONFIG.X_DAILY_GOALS_KEY));
  premiumTier = ((await getLocal(CONFIG.X_PREMIUM_KEY)) as string) || "";
  profileState = (await getLocal(CONFIG.X_PROFILE_KEY)) as ProfileState | undefined;
  myFollowers = Number(await getLocal(CONFIG.X_MY_FOLLOWERS_KEY)) || 0;
  paceResetAt = Number(await getLocal(CONFIG.X_PACE_RESET_KEY)) || 0;
  const storedLog = await getLocal(CONFIG.X_REPLY_LOG_KEY);
  if (storedLog && typeof storedLog === "object") {
    const l = storedLog as Partial<ReplyLog>;
    const daily = l.daily && typeof l.daily === "object" ? (l.daily as Record<string, number>) : {};
    // Seed all-time from existing per-day history if it predates the `total` field.
    const total = typeof l.total === "number" ? l.total : Object.values(daily).reduce((a, b) => a + (b || 0), 0);
    replyLog = {
      times: Array.isArray(l.times) ? l.times : [],
      authors: l.authors && typeof l.authors === "object" ? (l.authors as Record<string, number>) : {},
      drafts: Array.isArray(l.drafts) ? l.drafts : [],
      daily,
      total,
      sent: Array.isArray(l.sent) ? (l.sent as SentRecord[]) : [],
    };
    for (const r of replyLog.sent) if (r.postId) commentedIds.add(r.postId); // posts you've replied to → "✓ Commented" in the feed
  }
  goobiLastSeen = (await getLocal(CONFIG.X_GOOBI_SEEN_KEY)) as number || 0;
  if (goobiLastSeen && Date.now() - goobiLastSeen >= 2 * DAY_MS) goobiWelcomeBack = true; // away a while → he missed you
  const storedFed = await getLocal(CONFIG.X_GOOBI_FED_KEY); // what Goobi has eaten, across sessions
  if (storedFed && typeof storedFed === "object") {
    const f = storedFed as { ids?: string[]; total?: number };
    (f.ids || []).forEach((id) => fedEver.add(id));
    fedTotal = Number(f.total) || fedEver.size;
  }
  const storedIdeas = await getLocal(CONFIG.X_IDEAS_KEY); // the post-ideas drafts queue
  if (Array.isArray(storedIdeas)) ideaQueue = (storedIdeas as IdeaRecord[]).filter((r) => r && r.id && typeof r.text === "string");
  const storedOwn = await getLocal(CONFIG.X_MY_POSTS_KEY) as { stats?: OwnPost[] } | undefined; // seed the views stat from cache (no fetch on boot — that happens on dock-open, to save budget)
  if (storedOwn?.stats) { ownStats = storedOwn.stats; reconcileIdeasWithOwnPosts(); }
  const storedLearn = await getLocal(CONFIG.X_LEARN_STATS_KEY) as LearnStore | undefined; // engagement learning store (own-post trend + scan gates)
  if (storedLearn?.handle) learn = storedLearn;
  hydrateInbound(await getLocal(CONFIG.X_SUPPORTERS_KEY)); // who engages with me (reciprocity)
  relationshipMemory = pruneRelationshipMemory(await getLocal(CONFIG.X_RELATIONSHIP_MEMORY_KEY) as RelationshipMemoryStore | undefined, Date.now());
  foldRelationshipMemory(); // backfill any exact joins already present in the two older stores
  hydrateThreadsDone(await getLocal(CONFIG.X_THREADS_DONE_KEY)); // threads I've marked done
  { // cross-session coverage caches (public author data + niche-stamped heavy hitters), TTL-pruned on load
    const now = Date.now();
    opportunityMetrics = pruneOpportunityMetrics((await getLocal(CONFIG.X_OPPORTUNITY_METRICS_KEY)) as OpportunityMetricStore | undefined, now);
    const storedR = (await getLocal(CONFIG.X_AUTHOR_REACH_KEY)) as Record<string, { followers?: number; following?: number; bio?: string; at: number }> | undefined;
    for (const [k, v] of Object.entries(storedR ?? {})) if (v?.at && now - v.at < AUTHOR_REACH_TTL_MS && !authorReach.has(k)) authorReach.set(k, v);
    const storedH = (await getLocal(CONFIG.X_HEAVY_HITTERS_KEY)) as HeavyHitterStore | undefined;
    if (storedH?.niche && storedH.niche === xNiche.trim()) {
      for (const [k, v] of Object.entries(storedH.entries ?? {})) if (v?.at && now - v.at < HEAVY_HITTER_TTL_MS && !heavyHitters.has(k)) heavyHitters.set(k, v);
    }
    syncFreshReachShortlistIntoRadar();
  }
  const ownHandle = await myHandle();
  freshReachWatchStore = normalizeFreshReachWatchStore(await getLocal(CONFIG.X_FRESH_REACH_WATCHLIST_KEY), ownHandle || getSelf());
  const storedTargets = await getLocal(CONFIG.X_TARGETS_KEY) as TargetStore | undefined; // big-account target list
  if (storedTargets && Array.isArray(storedTargets.targets) && (!storedTargets.handle || !ownHandle || storedTargets.handle === ownHandle)) targetStore = { ...storedTargets, handle: ownHandle || storedTargets.handle };
  else if (ownHandle) targetStore = freshStore(ownHandle); // a different account's list — don't bleed it across users
  dmStore = pruneDmStore(ownHandle ? await getLocal(dmStorageKey(ownHandle)) as DmStore | undefined : undefined, ownHandle, Date.now());
  await ensureGrowthOwner();
  void loadFavicons();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CONFIG.X_PRODUCTS_KEY]) { xProducts = (changes[CONFIG.X_PRODUCTS_KEY].newValue as ProductItem[]) || []; void loadFavicons(); renderDock(); }
    if (changes[CONFIG.X_PRODUCT_KEY]) legacyProduct = (changes[CONFIG.X_PRODUCT_KEY].newValue as string) || "";
    if (changes[CONFIG.X_DEFAULT_ANGLE_KEY]) xDefaultAngle = (changes[CONFIG.X_DEFAULT_ANGLE_KEY].newValue as string) || "";
    if (changes[CONFIG.X_DEFAULT_PRODUCT_KEY]) xDefaultProduct = (changes[CONFIG.X_DEFAULT_PRODUCT_KEY].newValue as string) || "";
    if (changes[CONFIG.X_REPLY_INSERT_KEY]) xReplyInsertOn = changes[CONFIG.X_REPLY_INSERT_KEY].newValue === true;
    if (changes[CONFIG.X_REPLY_HANDOFF_KEY]) void maybeFulfillReplyHandoff(); // an already-open exact status tab can claim the new draft without a duplicate tab
    if (changes[CONFIG.X_DAILY_GOALS_KEY]) { dailyGoals = normalizeDailyGoals(changes[CONFIG.X_DAILY_GOALS_KEY].newValue); renderDock(); }
    if (changes[CONFIG.X_LEARN_LOOP_KEY]) { learnLoopOn = changes[CONFIG.X_LEARN_LOOP_KEY].newValue === true; invalidateLearnedMults(); renderDock(); } // flip the loop live (no reload), and re-rank the dock under the new weighting
    if (changes[CONFIG.X_DEBUG_KEY]) { debugOn = changes[CONFIG.X_DEBUG_KEY].newValue === true; installDebugHook(); }
    if (changes[CONFIG.X_PREMIUM_KEY]) premiumTier = (changes[CONFIG.X_PREMIUM_KEY].newValue as string) || "";
    if (changes[CONFIG.X_PROFILE_KEY]) {
      profileState = changes[CONFIG.X_PROFILE_KEY].newValue as ProfileState | undefined;
      if (!dockInputFocused()) renderDock();
    }
    if (changes[CONFIG.X_NICHE_KEY]) {
      xNiche = (changes[CONFIG.X_NICHE_KEY].newValue as string) || "";
      heavyHitters = new Map(); heavyTried = false; showAllFreshRadar = false; // the radar is tied to the active scoring context; re-discover when that context changes
      syncFreshReachShortlistIntoRadar(); // measured winners survive a niche change; every new post is still content-gated against the new niche
    }
    if (changes[CONFIG.X_PAUSED_KEY]) { const p = changes[CONFIG.X_PAUSED_KEY].newValue === true; if (p !== paused) { paused = p; if (p && dockPlayOpen) resetPlay(); renderDock(); if (!p) rescan(); } } // synced from the popup / another tab
    if (changes[CONFIG.X_MY_FOLLOWERS_KEY]) { myFollowers = Number(changes[CONFIG.X_MY_FOLLOWERS_KEY].newValue) || 0; syncFreshReachShortlistIntoRadar(); captureGrowthData(); renderDock(); }
    if (changes[CONFIG.X_MY_HANDLE_KEY]) {
      selfHandle = ""; ownStats = undefined; growthOwnerProblem = "";
      void ensureTargetOwner(); void ensureFreshReachWatchOwner(); void ensureDmOwner(); void ensureGrowthOwner().then(() => renderDock());
    }
    if (changes[CONFIG.X_LEARN_STATS_KEY]) { const nv = changes[CONFIG.X_LEARN_STATS_KEY].newValue as LearnStore | undefined; if (nv?.handle) { learn = nv; foldRelationshipMemory(); renderDock(); } } // synced from another tab's daily scan
    if (changes[CONFIG.X_IDEAS_KEY]) {
      // Another tab wrote the drafts queue (set/cleared a reminder, toasted a due one, shipped).
      // Adopt only when this tab isn't mid-edit (a rebuild would eat the caret) and skip our own
      // echo (same serialized value). remindedAt syncing here is what prevents double toasts.
      const nv = changes[CONFIG.X_IDEAS_KEY].newValue;
      if (Array.isArray(nv) && !dockInputFocused() && JSON.stringify(nv) !== JSON.stringify(ideaQueue)) {
        ideaQueue = (nv as IdeaRecord[]).filter((r) => r && r.id && typeof r.text === "string");
        renderDock();
      }
    }
    if (changes[CONFIG.X_REPLY_LOG_KEY]) {
      // Another tab wrote the reply ledger. MERGE (union), never adopt — a stale tab's blob must not
      // reset the rolling-hour count the ease-off safety guard reads, or defeat the daily tally.
      const nv = changes[CONFIG.X_REPLY_LOG_KEY].newValue as Partial<ReplyLog> | undefined;
      if (nv && typeof nv === "object") { replyLog = mergeReplyLog(replyLog, nv); invalidateLearnedMults(); syncFreshReachShortlistIntoRadar(); for (const r of replyLog.sent) if (r.postId) commentedIds.add(r.postId); renderDock(); }
    }
    if (changes[CONFIG.X_PACE_RESET_KEY]) {
      paceResetAt = Number(changes[CONFIG.X_PACE_RESET_KEY].newValue) || 0;
      renderDock(); requestScan();
    }
    if (changes[CONFIG.X_SUPPORTERS_KEY]) { hydrateInbound(changes[CONFIG.X_SUPPORTERS_KEY].newValue); foldRelationshipMemory(); renderDock(); } // synced from another tab's notifications harvest (validated, not trusted raw)
    if (changes[CONFIG.X_RELATIONSHIP_MEMORY_KEY]) {
      relationshipMemory = mergeRelationshipMemory(relationshipMemory, changes[CONFIG.X_RELATIONSHIP_MEMORY_KEY].newValue as RelationshipMemoryStore | undefined, Date.now());
      if (!dockInputFocused()) renderDock();
    }
    if (changes[CONFIG.X_THREADS_DONE_KEY]) { hydrateThreadsDone(changes[CONFIG.X_THREADS_DONE_KEY].newValue); renderDock(); } // marked-done threads synced from another tab
    if (changes[CONFIG.X_OPPORTUNITY_METRICS_KEY]) {
      opportunityMetrics = mergeOpportunityMetricStores(opportunityMetrics, changes[CONFIG.X_OPPORTUNITY_METRICS_KEY].newValue as OpportunityMetricStore | undefined, Date.now());
      if (!dockInputFocused()) renderDock();
    }
    if (changes[CONFIG.X_TARGETS_KEY]) { const nv = changes[CONFIG.X_TARGETS_KEY].newValue as TargetStore | undefined; if (nv && Array.isArray(nv.targets) && (!dmStore.ownerHandle || !nv.handle || nv.handle.toLowerCase() === dmStore.ownerHandle)) { targetStore = nv; renderDock(); } } // synced only for the active owner
    if (changes[CONFIG.X_FRESH_REACH_WATCHLIST_KEY]) {
      const owner = freshReachWatchStore.ownerHandle || dmStore.ownerHandle || learn.handle || selfHandle;
      freshReachWatchStore = normalizeFreshReachWatchStore(changes[CONFIG.X_FRESH_REACH_WATCHLIST_KEY].newValue, owner);
      if (!dockInputFocused()) renderDock();
    }
    const liveDmKey = dmStore.ownerHandle ? dmStorageKey(dmStore.ownerHandle) : "";
    if (liveDmKey && changes[liveDmKey]) {
      const incoming = pruneDmStore(changes[liveDmKey].newValue as DmStore | undefined, dmStore.ownerHandle, Date.now());
      const merged = mergeDmStores(dmStore, incoming, dmStore.ownerHandle, Date.now());
      const needsRepair = JSON.stringify(merged) !== JSON.stringify(incoming);
      dmStore = merged;
      if (needsRepair) persistDms(merged); // converge a last-writer-wins storage race back to the union
      if (!dockInputFocused()) renderDock();
    }
    const liveGrowthKey = growthStore.ownerHandle ? growthStorageKey(growthStore.ownerHandle) : "";
    if (liveGrowthKey && changes[liveGrowthKey]) {
      growthStore = mergeGrowthStores(growthStore, changes[liveGrowthKey].newValue as GrowthStore | undefined, growthStore.ownerHandle, Date.now());
      if (!dockInputFocused()) renderDock();
    }
    if (changes[CONFIG.TWTTR_KEY_KEY]) {
      // RapidAPI key changed — let lookups try again and drop the failed-lookup backoff.
      twttrUnconfigured = false;
      for (const [k, v] of authorReach) if (v.failed) authorReach.delete(k);
    }
  });
  renderDock();
  bodyObs = new MutationObserver(() => requestScan());
  bodyObs.observe(document.body, { childList: true, subtree: true });

  // Content scripts can't intercept the page's history.pushState, so poll the URL.
  let lastUrl = location.href;
  urlPoll = setInterval(() => {
    if (invalidated || !contextOK()) { teardown(); return; }
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    dismissPanel();
    if (seen.size > 600) { seen.clear(); opps.clear(); authorReach.clear(); } // bound memory across long sessions
    selfHandle = "";
    void maybeFulfillReplyHandoff();
    requestScan();
    renderDock();
  }, 700);

  checkDueReminders(); // anything already due on load toasts once now (the SW badge is separate)
  remindPoll = setInterval(checkDueReminders, 30_000);

  // Pace pressure decays continuously rather than dropping at a rigid one-hour cliff. Refresh only
  // when the displayed tenth/level changes; leaving ease-off also resumes ambient scanning.
  let lastPaceKey = "";
  pacePoll = setInterval(() => {
    const pace = currentReplyPace();
    const nextKey = `${pace.level}:${pace.pressure.toFixed(1)}:${pace.resetAt ?? 0}`;
    if (nextKey === lastPaceKey) return;
    const wasEaseoff = lastPaceKey.startsWith("easeoff:");
    lastPaceKey = nextKey;
    if (!dockInputFocused()) renderDock();
    if (wasEaseoff && pace.level !== "easeoff") requestScan();
  }, 30_000);

  scan();
}

const host = location.hostname;
if (window.top === window && /(^|\.)(x|twitter)\.com$/.test(host)) {
  void boot();
}
