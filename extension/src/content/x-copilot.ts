import { CONFIG } from "../lib/config";
import { REPLY_ANGLES } from "../lib/prompts";
import { parseTimelineTweets, parseUser, pickDiscoveryTweets, pickOwnPostsWithStats, type OwnPost, type TwttrTweet } from "../lib/twttr";
import { computeMomentum } from "../lib/momentum";
import { aggregateAccounts, rankAccounts, concentration, cadenceTrend, foldOwnDelta, matchOutcomes, GLOBAL_THIN, type PostMetrics, type DailyDelta, type FetchedReply } from "../lib/learn-stats";
import { aggregateSupporters, rankSupporters, fuseMutual, cadence as supCadence, reciprocalConcentration, GLOBAL_THIN as SUP_GLOBAL_THIN, type EngagedRecord, type EngagedKind, type Rel } from "../lib/supporters";
import { isDuplicateReply, normalizeReply, pickReplyNudge, reputationStatus, REPLY_HARD_PER_HOUR } from "../lib/reply-hygiene";
import { humanDelayMs, jitterGap } from "../lib/human-pacing";
import { mountGoobi, type GoobiMood, type GoobiHandle } from "../lib/goobi";
import { builderTier } from "../lib/community";
import type { ProductItem } from "../lib/types";

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

/** Twttr (X-data API) enrichment, all read-only + best-effort. */
let xNiche = "";              // the niche query "Find spots" searches X for
let myFollowers = 0;          // the user's own follower count, for the reach sweet-spot
let twttrUnconfigured = false; // once the SW reports no key/host, stop trying until settings change

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

/** The angle a draft should open with: the user's default if set, else the scorer's pick. */
function initialAngle(category?: string): string | undefined { return xDefaultAngle || category; }
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

/** status id -> last result. Authoritative dedup + instant re-badge on remount. */
const seen = new Map<string, { score: number; reason: string; category?: string; products?: ProductItem[] }>();

/** Collected reply-worthy posts, surfaced in the always-on dock. */
interface Opp { id: string; author: string; text: string; score: number; reason: string; context?: string; postedAt?: number; likes?: number; replies?: number; avatar?: string; category?: string; products?: ProductItem[]; name?: string; followers?: number; source?: "feed" | "search"; verified?: boolean; manual?: boolean; }
const opps = new Map<string, Opp>();
let dockOpen = false;
let dockFilter = "";

interface Queued { id: string; author: string; text: string; el: HTMLElement; }
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
function contextOK(): boolean { try { return !!chrome.runtime?.id; } catch { return false; } }
function teardown(): void {
  if (invalidated) return;
  invalidated = true;
  try { bodyObs?.disconnect(); } catch { /* ignore */ }
  if (urlPoll) clearInterval(urlPoll);
  if (flushTimer) clearTimeout(flushTimer);
  try { resetPlay(); } catch { /* ignore */ } // destroy the big Goobi + cancel in-flight treats
  try { stopIdeasGoobi(); } catch { /* ignore */ }
  try { dockHost?.remove(); } catch { /* ignore */ } // detaching the dock stops Goobi's loops (they self-guard on isConnected)
  try { dismissPanel(); } catch { /* ignore */ }
}

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
 *  recycles the node; the timestamp is absolute so age stays accurate). */
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

function scan() {
  if (!enabled || paused) return;
  // On the notifications route, harvest who engaged with ME instead of scoring posts to reply to.
  if (location.pathname.startsWith("/notifications")) { scanNotifications(); return; }
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
      if (commentedIds.has(info.id)) badge(el, cached.reason, cached.category, o ? effectiveScore(o) : cached.score); // replied → green badge, not in the dock
      else if (o) badge(el, o.reason, o.category, effectiveScore(o)); // surfaced (auto-scored or manually added)
      else addButton(el); // scored but didn't make the cut → offer a manual "+ Add"
      return;
    }
    if (el.dataset.tbx === "q") return; // this node already queued
    if (isPromoted(el)) return;
    if (selfHandle && info.author.toLowerCase() === selfHandle) return;
    const text = outerText(el);
    if (!text) return; // media-only / not painted yet — re-evaluated next pass
    el.dataset.tbx = "q";
    queue.push({ id: info.id, author: info.author, text: text.slice(0, 400), el });
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
  const posts = batch.map((b, i) => ({ i, author: b.author, text: b.text })); // content/fit only; timing+reach handled live by effectiveScore
  batch.forEach((b) => inFlight.add(b.id));
  refreshGoobi(); // Goobi concentrates while Claude analyzes the batch
  const resp = await send<{ scores?: { i: number; score: number; reason: string; category?: string; products?: string[] }[]; error?: string }>({
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
    seen.set(b.id, { score: s.score, reason, category, products });
    if (commentedIds.has(b.id)) {
      // Already replied to it — never surface it in the dock; keep only the green "✓ Commented" badge.
      if (opps.delete(b.id)) changed = true;
      if (statusInfo(b.el)?.id === b.id) badge(b.el, reason, category, s.score);
    } else if (s.score >= THRESHOLD) {
      opps.set(b.id, { id: b.id, author: b.author, text: b.text, score: s.score, reason, category, products, context: b.el.isConnected ? quotedText(b.el) : undefined, postedAt: stat.postedAt, likes: stat.likes, replies: stat.replies, avatar: stat.avatar, name: stat.name, verified: stat.verified });
      changed = true;
      if (statusInfo(b.el)?.id === b.id) badge(b.el, reason, category, effectiveScore(opps.get(b.id)!));
    } else {
      const ex = opps.get(b.id);
      if (ex?.manual) {
        // You pinned this one with "+ Add" — keep it, just refresh its real score/tag.
        ex.score = s.score; ex.reason = reason; ex.category = category;
        changed = true;
        if (statusInfo(b.el)?.id === b.id) badge(b.el, reason, category, effectiveScore(ex));
      } else {
        // Re-scored below threshold (e.g. after a Rescan): prune the stale spot + badge.
        if (opps.delete(b.id)) changed = true;
        if (b.el.isConnected) b.el.querySelector("[data-tbx-badge]")?.remove();
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
/** Search X (via the Twttr API) for fresh posts in the user's niche, score them
 *  with the same Claude scorer the feed uses, and drop the worthwhile ones into
 *  the dock. These are OFF the current page: Draft/Copy work, but inserting into
 *  a reply box needs the post opened (the panel/toast guide that). */
async function findSpots() {
  if (findingSpots) return;
  if (!enabled) { toast("Add your Anthropic key in the Goobi panel to score posts."); return; }
  const q = xNiche.trim();
  if (!q) { toast("Set your niche in the Goobi panel so it knows what to search for."); return; }
  findingSpots = true;
  renderDock();
  toast("Searching X for fresh posts in your niche…");
  try {
    const search = await send<{ ok?: boolean; status?: number; data?: unknown; error?: string }>({
      type: "TWTTR_GET", path: "search-v3", query: { type: "Latest", count: "30", query: q.slice(0, 120) }, intent: true,
    });
    if (search?.error === "no-twttr-config") { twttrUnconfigured = true; toast("Add your RapidAPI key in the Goobi panel to find spots."); return; }
    if (search?.error?.startsWith("budget-")) { toast("Monthly X-data budget nearly used — Find spots is paused. It resets on the 1st."); return; }
    if (!search?.ok) {
      const s = search?.status;
      const why = s === 401 || s === 403 ? "Key invalid or not subscribed to twitter241 on RapidAPI." : "Check your RapidAPI key in the popup.";
      toast(`X search failed${s ? ` (HTTP ${s})` : ""}. ${why}${search?.error ? ` — provider says: ${search.error}` : ""}`);
      return;
    }
    if (!selfHandle) selfHandle = getSelf();
    const found = pickDiscoveryTweets(search.data, 18)
      .filter((t) => !selfHandle || t.author.toLowerCase() !== selfHandle)
      .filter((t) => !opps.has(t.id) && !seen.has(t.id));
    if (!found.length) { toast("No new posts found for your niche right now."); return; }
    const posts = found.map((t, i) => ({ i, author: t.author, text: t.text.slice(0, 400) }));
    const resp = await send<{ scores?: { i: number; score: number; reason: string; category?: string; products?: string[] }[]; error?: string }>({ type: "SCORE_POSTS", posts });
    if (resp?.error === "no-key") { toast("Add your Anthropic key in the Goobi panel to score posts."); return; }
    if (!resp || resp.error) { toast("Couldn't score the posts — try again."); return; }
    let added = 0;
    for (const s of resp.scores ?? []) {
      const t = found[s.i];
      if (!t) continue;
      const reason = (s.reason || "").split(/\s+/).slice(0, 6).join(" ");
      const category = catId(s.category);
      const products = category === "promote" && Array.isArray(s.products)
        ? s.products.map((n) => xProducts.find((p) => p.name === n)).filter((p): p is ProductItem => !!p).slice(0, 2)
        : undefined;
      seen.set(t.id, { score: s.score, reason, category, products });
      if (s.score >= THRESHOLD) {
        opps.set(t.id, { id: t.id, author: t.author, text: t.text.slice(0, 400), score: s.score, reason, category, products, postedAt: t.postedAt, likes: t.likes, replies: t.replies, avatar: t.avatar, name: t.name, followers: t.followers, source: "search" });
        if (t.author && t.followers != null) authorReach.set(t.author.toLowerCase(), { followers: t.followers, at: Date.now() }); // search already told us the author's reach
        added++;
      }
    }
    toast(added ? `Found ${added} fresh reply ${added === 1 ? "spot" : "spots"} in your niche.` : "Searched, but nothing scored high enough to surface.");
  } finally {
    findingSpots = false;
    renderDock();
  }
}

/* ---------- badge (idempotent; survives X re-renders via cache re-apply) ---------- */

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

function badge(el: HTMLElement, reason: string, category?: string, score?: number) {
  // The badge mirrors the dock card (reply-fit score % + category tag) and flips to a
  // green "✓ Commented" call-out once you've replied to this post.
  const id = statusInfo(el)?.id;
  const done = !!id && commentedIds.has(id);
  const pct = score != null ? Math.round(Math.max(0, Math.min(1, score)) * 100) : null;
  const core = pct != null ? `${pct}% · ${catLabel(category)}` : catLabel(category);
  const label = done ? `✓ Commented · ${core}` : `✦ ${core}`;
  const tip = (done ? "You've replied to this post. " : "") + (pct != null ? `${scoreVerdict(score!).label} reply fit (${pct}%) — ` : "") + reason;
  const bg = done ? DONE : ACCENT;
  const fg = done ? DONE_INK : INK;
  const existing = el.querySelector<HTMLElement>("[data-tbx-badge]");
  if (existing) {
    // Already badged — keep the label/colors current (category re-classified on a
    // Rescan, score drifts, or you just commented), so it never shows a stale value.
    existing.textContent = label;
    existing.title = tip;
    existing.style.background = bg;
    existing.style.color = fg;
    el.style.borderLeftColor = bg;
    return;
  }
  el.querySelector("[data-tbx-add]")?.remove(); // surfacing replaces the faint "+ Add" affordance
  el.style.borderLeft = `3px solid ${bg}`;
  el.style.borderTopLeftRadius = "4px";
  el.style.borderBottomLeftRadius = "4px";
  if (getComputedStyle(el).position === "static") el.style.position = "relative";

  const b = document.createElement("button");
  b.setAttribute("data-tbx-badge", "1");
  b.textContent = label;
  b.title = tip;
  Object.assign(b.style, {
    position: "absolute", top: "10px", right: "60px", zIndex: "9999",
    background: bg, color: fg, border: "0", borderRadius: "999px",
    font: "600 11px -apple-system, system-ui, sans-serif", padding: "3px 10px", cursor: "pointer",
  } as Partial<CSSStyleDeclaration>);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    void openDraftFromEl(el);
  });
  el.appendChild(b);
}

/** A faint "+ Add" affordance on a post the scorer saw but didn't surface (below
 *  THRESHOLD). Lets you override the system and pull it into the dock + score it. */
function addButton(el: HTMLElement) {
  if (el.querySelector("[data-tbx-badge]") || el.querySelector("[data-tbx-add]")) return; // already surfaced or already offered
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  const a = document.createElement("button");
  a.setAttribute("data-tbx-add", "1");
  a.textContent = "+ Add";
  a.title = "Goobi passed on this one — add it anyway to score it and pull it into your reply list.";
  Object.assign(a.style, {
    position: "absolute", top: "10px", right: "60px", zIndex: "9998",
    background: "transparent", color: "#8c7d68", border: "1px solid rgba(214,154,92,.45)", borderRadius: "999px",
    font: "600 11px -apple-system, system-ui, sans-serif", padding: "2px 9px", cursor: "pointer", opacity: "0.5",
  } as Partial<CSSStyleDeclaration>);
  a.addEventListener("mouseenter", () => Object.assign(a.style, { opacity: "1", background: ACCENT, color: INK, borderColor: "transparent" }));
  a.addEventListener("mouseleave", () => Object.assign(a.style, { opacity: "0.5", background: "transparent", color: "#8c7d68", borderColor: "rgba(214,154,92,.45)" }));
  a.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); void addManual(el); });
  el.appendChild(a);
}

/** Pin a post into the dock by hand (from "+ Add"), then score it for real so it
 *  gets a proper tag/angle. Manual opps are never pruned, even if they score low. */
async function addManual(el: HTMLElement) {
  const info = statusInfo(el);
  const text = outerText(el);
  if (!info || !text) { toast("Couldn't read that post."); return; }
  el.querySelector("[data-tbx-add]")?.remove();
  if (opps.has(info.id)) { dockOpen = true; renderDock(); toast("That post is already in your list."); return; }
  const stat = snapStats(el);
  const cached = seen.get(info.id);
  const opp: Opp = {
    id: info.id, author: info.author, text: text.slice(0, 400), manual: true,
    score: cached?.score ?? 0.5, reason: cached?.reason || "Added by you", category: cached?.category,
    context: quotedText(el), postedAt: stat.postedAt, likes: stat.likes, replies: stat.replies,
    avatar: avatarUrl(el), name: displayName(el), verified: isVerified(el),
  };
  opps.set(info.id, opp);
  seen.set(info.id, { score: opp.score, reason: opp.reason, category: opp.category });
  badge(el, opp.reason, opp.category, effectiveScore(opp));
  dockOpen = true; renderDock();
  toast("Added to your reply list — scoring it…");
  // Score it for real (one call, bypasses the per-session cap) to fill in the tag/angle.
  const resp = await send<{ scores?: { i: number; score: number; reason: string; category?: string }[]; error?: string }>({ type: "SCORE_POSTS", posts: [{ i: 0, author: info.author, text: opp.text }] });
  const s = resp?.scores?.[0];
  const cur = opps.get(info.id);
  if (s && cur?.manual) { // keep it pinned; just adopt the real score/tag
    cur.score = s.score; cur.reason = (s.reason || "").split(/\s+/).slice(0, 6).join(" ") || cur.reason; cur.category = catId(s.category) ?? cur.category;
    seen.set(info.id, { score: cur.score, reason: cur.reason, category: cur.category });
    if (statusInfo(el)?.id === info.id) badge(el, cur.reason, cur.category, effectiveScore(cur));
    renderDock();
  }
}

/* ---------- draft panel (closed shadow root, CSP-safe) ---------- */

const PANEL_CSS = `
.p { width: 340px; max-width: calc(100vw - 36px); background: #1d1812; color: #f3ead9;
     border: .5px solid rgba(214,154,92,.18); border-radius: 14px; padding: 14px;
     font: 13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
     box-shadow: 0 12px 40px rgba(0,0,0,.5); }
.h { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.th { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pav { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
.t { font-weight: 600; } .x { background: none; border: 0; color: #8c7d68; font-size: 14px; cursor: pointer; }
.ctx { font-size: 12px; color: #b6a892; max-height: 60px; overflow: auto; margin-bottom: 10px;
       border-left: 2px solid rgba(214,154,92,.25); padding-left: 8px; }
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
.foot { margin-top: 9px; font-size: 10.5px; color: #8c7d68; }
.steer { width: 100%; box-sizing: border-box; margin-top: 10px; background: #1a1510; color: #f3ead9;
         border: .5px solid rgba(214,154,92,.28); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 12px; }
.steer::placeholder { color: #8c7d68; }
.steer:focus { outline: none; border-color: ${ACCENT}; }
`;

let panelHost: HTMLElement | null = null;
let panelRoot: ShadowRoot | null = null;
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
  panelHost = document.createElement("div");
  Object.assign(panelHost.style, { position: "fixed", bottom: "18px", right: "18px", zIndex: "2147483647" } as Partial<CSSStyleDeclaration>);
  panelRoot = panelHost.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(PANEL_CSS);
  panelRoot.adoptedStyleSheets = [sheet];
  trapKeys(panelHost); // keep X's keyboard shortcuts from hijacking typing in the draft/steer fields
  document.documentElement.appendChild(panelHost);
  return panelRoot;
}
function dismissPanel() { panelHost?.remove(); panelHost = null; panelRoot = null; }

let draftGetEl: (() => HTMLElement | null) | null = null;
let draftOppId: string | null = null;
let draftOppAuthor = "";
/** Cross-session reply-reputation log. X penalties attach to the ACCOUNT (they
 *  suppress reach ongoing, not per-reply), so this persists across navigations +
 *  restarts: times = reply timestamps (rolling hour) for the volume guard,
 *  authors = last-replied-at per handle for the spread guard, drafts = recent
 *  normalized reply texts for the duplicate-reply guard. Persisted on each insert. */
/** One sent reply's features — the raw material for the planned "what's working"
 *  learning loop. NOT YET IMPLEMENTED: `outcome` is reserved for a future measure
 *  pass (match to your posted reply via /user-replies, read its engagement) — nothing
 *  currently writes it. See CHANGELOG.md "Next phase". */
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
  norm?: string;         // normalized reply text (match + dedup)
  snippet?: string;      // first 80 chars of the reply (match via /user-replies)
  avatar?: string;       // the author's profile picture (so the playground treat wears their face)
  outcome?: { at: number; likes?: number; replies?: number; authorReplied?: boolean; frozen?: boolean };
}
interface ReplyLog { times: number[]; authors: Record<string, number>; drafts: { norm: string; at: number }[]; daily: Record<string, number>; total: number; sent: SentRecord[]; }
let replyLog: ReplyLog = { times: [], authors: {}, drafts: [], daily: {}, total: 0, sent: [] };
let sentSeq = 0; // bump per reply so two in the same millisecond still get distinct ids
const commentedIds = new Set<string>(); // post ids you've replied to — drives the "✓ commented" badge in the feed
const SENT_MAX = 500; // cap the feature log

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
interface DraftReq { author: string; text: string; context?: string; getEl?: () => HTMLElement | null; oppId?: string; angle?: string; avatar?: string; products?: ProductItem[]; productIndex?: number; name?: string; steer?: string; }
let lastDraft: DraftReq | null = null;

/** Posts already liked this session, so re-drafts / angle switches don't re-toggle. */
const liked = new Set<string>();

/** Heart the OUTER post (skip the quoted tweet's bar). X's button is testid
 *  "like" only while UNliked — once liked it becomes "unlike", so a click here
 *  can only ever like, never un-like. No-op if the post is already liked. */
function likePost(id: string | null, el: HTMLElement | null): void {
  if (!id && !el?.isConnected) return;
  // A human doesn't like in the same millisecond they finish a reply — land it a
  // natural beat later. The timeline virtualizes, so re-resolve the post by id at
  // click time (strict id match); never like a recycled element showing another tweet.
  setTimeout(() => {
    const target = id ? findPost(id) : (el?.isConnected ? el : null);
    if (!target?.isConnected) return;
    const btns = Array.from(target.querySelectorAll<HTMLElement>('[data-testid="like"]'));
    (btns.find((b) => !b.closest('[role="link"]')) || btns[0])?.click();
  }, humanDelayMs("settle"));
}

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
 *  following — so this can only follow, never unfollow. User-initiated + paced
 *  (min-gap + hourly cap) so it never produces a rapid-follow velocity flag. */
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
 *  Insert degrades to the "open the post, then Insert" path. Pass no text to
 *  force a strict id-only lookup. */
function findPost(id: string, text?: string): HTMLElement | null {
  let byText: HTMLElement | null = null;
  const needle = text?.slice(0, 60);
  for (const a of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
    const info = statusInfo(a);
    if (info?.id === id) return a;  // id match wins
    if (info) continue;             // a different, identifiable tweet — never a fallback target
    if (needle && !byText && outerText(a).startsWith(needle)) byText = a;
  }
  return byText;
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The actual contenteditable inside X's composer (the testid node may wrap it). */
function editableOf(node: HTMLElement): HTMLElement {
  if (node.getAttribute("contenteditable") === "true") return node;
  return node.querySelector<HTMLElement>('[contenteditable="true"]') || node;
}
function placeCaretEnd(ce: HTMLElement) {
  try {
    const r = document.createRange();
    r.selectNodeContents(ce);
    r.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  } catch { /* ignore */ }
}

/** Put text into X's DraftJS editor. First types it in word-by-word (verified —
 *  DraftJS silently drops repeated inserts, so each word is confirmed and the moment
 *  one drops we bail), then falls back to a reliable one-shot insert (exec → paste →
 *  beforeinput). Success is LENGTH-aware (`complete`, not just "non-empty"), so a
 *  partial fill can never be mistaken for success and the box is never left half-done. */
async function typeInto(node: HTMLElement, text: string): Promise<boolean> {
  const ce = editableOf(node);
  const norm = (s: string) => s.replace(/​/g, "").replace(/\s+/g, " ").trim();
  const want = norm(text);
  const got = () => norm(ce.textContent || "");
  const filled = () => got().length > 0;
  const complete = () => want.length > 0 && got().length >= want.length * 0.9; // FULL reply landed; never "complete" on empty text

  const clear = () => {
    try {
      ce.focus();
      const r = document.createRange(); r.selectNodeContents(ce);
      const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
      document.execCommand("delete", false);
    } catch { /* ignore */ }
  };
  // Empty the box, verified — DraftJS sometimes ignores a single delete.
  const ensureEmpty = async (): Promise<boolean> => {
    for (let i = 0; i < 4; i++) { if (!filled()) return true; clear(); await sleep(30); }
    return !filled();
  };
  const exec = () => { placeCaretEnd(ce); document.execCommand("insertText", false, text); };
  const paste = () => {
    try {
      const dt = new DataTransfer(); dt.setData("text/plain", text);
      ce.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch { /* ignore */ }
  };
  const beforeInput = () => {
    try {
      ce.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
      ce.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
    } catch { /* ignore */ }
  };

  // Reliable one-shot insert into an empty box, verified by `complete` (length-aware),
  // so a partial never counts as success. The proven path.
  const insertWhole = async (): Promise<boolean> => {
    for (const method of [exec, paste, beforeInput]) {
      ce.focus();
      await ensureEmpty();
      await sleep(20);
      placeCaretEnd(ce);
      method();
      for (let i = 0; i < 14; i++) { if (complete()) return true; await sleep(40); }
    }
    return complete();
  };

  // No typed cadence: repeated programmatic inserts POISON DraftJS — after a couple
  // words it stops accepting input entirely, so even a fallback can't recover and the
  // box is left with two words. The only reliable way is one verified shot. A brief
  // human pause before it is the only safe in-text cadence; the real human-pacing is
  // the spaced-out like/follow actions, not the keystrokes.
  await sleep(80 + humanDelayMs("react"));
  ce.focus();
  return await insertWhole();
}

/** Best-effort: open the post's reply box and type the draft into it. Never submits. */
async function insertReply(text: string, postEl: HTMLElement | null): Promise<"ok" | "no-composer" | "blocked"> {
  // Target the REPLY DIALOG's composer — never the page's main "what's happening"
  // box (which is also a tweetTextarea and would post to everyone).
  let editor = document.querySelector<HTMLElement>('[role="dialog"] [data-testid^="tweetTextarea_"]');
  if (!editor) {
    if (!postEl?.isConnected) return "no-composer";
    postEl.scrollIntoView({ block: "center" });
    const btn = postEl.querySelector<HTMLElement>('[data-testid="reply"]');
    if (!btn) return "no-composer";
    btn.click();
    // The reply composer opens inside a modal dialog (feed). Fall back to an
    // inline composer only on a post page, where there is no "everyone" box.
    editor =
      (await waitFor('[role="dialog"] [data-testid^="tweetTextarea_"]', 2500)) ||
      (location.pathname.includes("/status/") ? await waitFor('[data-testid^="tweetTextarea_"]', 600) : null);
  }
  if (!editor) return "no-composer";
  return (await typeInto(editor, text)) ? "ok" : "blocked";
}

let inserting = false;
/** Record an inserted reply in the persisted reputation log and return the single
 *  most important nudge (duplicate-reply > hourly volume > repeat-author), or null.
 *  Pattern-aware + cross-session, because X's penalties attach to the account. */
/** Bump today's "replies sent" tally + the all-time total; trim old days. */
function bumpDaily(now: number): void {
  const dk = dayKey(now);
  replyLog.daily[dk] = (replyLog.daily[dk] || 0) + 1;
  replyLog.total = (replyLog.total || 0) + 1;
  const cut = dayKey(now - 35 * 24 * HOUR_MS); // keep ~35 days of per-day history
  for (const k of Object.keys(replyLog.daily)) if (k < cut) delete replyLog.daily[k];
}

/** Append a feature record for the reply we just helped send — the raw material a
 *  future "what's working" loop could correlate with outcomes (not yet built). */
function logSentReply(now: number, text: string, opp?: Opp, angle?: string): void {
  const rec: SentRecord = {
    id: `${now}.${sentSeq++}`,
    at: now,
    postId: opp?.id ?? draftOppId ?? undefined,
    author: (opp?.author ?? draftOppAuthor) || undefined,
    score: opp ? effectiveScore(opp) : undefined,
    followers: opp ? knownFollowers(opp) : undefined,
    ageMs: opp?.postedAt ? Math.max(0, now - opp.postedAt) : undefined,
    category: opp?.category,
    angle: angle || opp?.category,
    norm: normalizeReply(text) || undefined,
    snippet: text.slice(0, 80),
    avatar: opp?.avatar,
  };
  replyLog.sent.push(rec);
  if (rec.postId) commentedIds.add(rec.postId); // mark this post as commented → "✓" badge in the feed
  if (replyLog.sent.length > SENT_MAX) replyLog.sent = replyLog.sent.slice(-SENT_MAX);
}

/** Record one reply the system handed you (Insert landed, or clipboard fallback):
 *  count it, log its features, persist, refresh the header. The click is the
 *  signal — no post-confirmation. */
function recordSentReply(text: string, opp?: Opp, angle?: string, now: number = Date.now()): void {
  const firstToday = (replyLog.daily[dayKey(now)] || 0) === 0;
  bumpDaily(now);
  logSentReply(now, text, opp, angle);
  const pid = opp?.id ?? draftOppId; // you replied → drop it from the dock (the feed badge handles the green "✓")
  if (pid) opps.delete(pid);
  touchGoobi();
  // Goobi beams when you reply — but NEVER when you're past the line (honest mirror:
  // he refuses to celebrate going too fast; at ease-off he stays woozy instead).
  // The first reply of a day that extends a streak earns a bigger 'cheer' (tada).
  if (repliesLastHour() < REPLY_HARD_PER_HOUR) {
    const streak = replyStreak();
    if (firstToday && streak >= 2) goobiReactLove(`${streak}-day streak!`, "love that you keep showing up", 3800);
    else goobiReactLove("Love it!", "that's the good stuff", 3200);
  }
  safeSet({ [CONFIG.X_REPLY_LOG_KEY]: replyLog });
  renderDock(); // update "N replies sent today" immediately
  requestScan(); // flip this post's in-feed badge to the green "✓ Commented" call-out
}

function recordReplyAndNudge(text: string, opp?: Opp, angle?: string): string | null {
  const now = Date.now();
  replyLog.times = replyLog.times.filter((t) => now - t < HOUR_MS);
  const author = draftOppAuthor.toLowerCase();
  const last = author ? replyLog.authors[author] : undefined;
  const repeat = last != null && now - last < AUTHOR_REPEAT_TTL;
  const norm = normalizeReply(text);
  const recentNorms = replyLog.drafts.filter((d) => now - d.at < DRAFT_TTL).map((d) => d.norm);
  const duplicate = isDuplicateReply(norm, recentNorms);
  // reputation-guard signals committed before the shared count/log
  replyLog.times.push(now);
  if (author) replyLog.authors[author] = now;
  if (norm) replyLog.drafts.push({ norm, at: now });
  replyLog.drafts = replyLog.drafts.filter((d) => now - d.at < DRAFT_TTL).slice(-DRAFT_MAX);
  recordSentReply(text, opp, angle, now);
  return pickReplyNudge({ duplicate, repliesThisHour: replyLog.times.length, repeatAuthor: repeat ? draftOppAuthor : null });
}

async function doInsert(text: string) {
  if (inserting) return; // ignore re-clicks while an insert is in flight (avoids doubling)
  if (!text.replace(/​/g, "").trim()) { toast("The draft is empty — nothing to insert."); return; } // never like/count a phantom reply
  inserting = true;
  try {
    // Snapshot the opportunity + angle BEFORE we delete the card, for the feature log.
    const opp = draftOppId ? opps.get(draftOppId) : undefined;
    const angle = lastDraft?.angle;
    const el = draftGetEl?.() ?? null;
    const r = await insertReply(text, el);
    if (r === "ok") {
      // Like the post only now — once you've actually committed to replying, not on
      // panel-open. Genuine, user-paced engagement, once per post.
      if (draftOppId && !liked.has(draftOppId)) { liked.add(draftOppId); likePost(draftOppId, el); }
      const warn = recordReplyAndNudge(text, opp, angle); // counts today's reply + reputation guard + feature log
      if (draftOppId) opps.delete(draftOppId);
      renderDock(); // after the count, so the "N today" header reflects this reply
      toast(warn || "Inserted into the reply box. Review it, then post.");
      dismissPanel();
    }
    else if (r === "no-composer") toast("Couldn't find a reply box. Open the post (↗), click Reply, then Insert.");
    else { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } recordSentReply(text, opp, angle); toast("X blocked the insert — copied it instead; paste it in."); }
  } finally {
    inserting = false;
  }
}

async function draftFor(req: DraftReq) {
  const { author, text, context, getEl, oppId, angle, avatar, name, steer } = req;
  draftGetEl = getEl ?? null;
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
  const resp = await send<{ reply?: string; error?: string }>({ type: "DRAFT_REPLY", author, text, context, angle, product, steer });
  goobiDrafting = false; refreshGoobi();
  if (resp?.error === "no-key") paintPanel(root, author, text, { note: "Add your Anthropic key in the Goobi panel to draft replies.", ...ui });
  else if (!resp || resp.error) paintPanel(root, author, text, { note: resp?.error ? `Couldn't draft: ${resp.error}` : "Couldn't draft — the background didn't respond. Try again.", ...ui });
  else paintPanel(root, author, text, { draft: resp.reply ?? "", ...ui });
}

/** The angle chips. Clicking re-drafts with that steer; clicking the active one
 *  toggles it back off (neutral). Reuses lastDraft so post/context are kept. */
function angleRow(active?: string): HTMLElement {
  const row = document.createElement("div"); row.className = "angles";
  for (const a of REPLY_ANGLES) {
    const c = document.createElement("button");
    c.className = "ang" + (active === a.id ? " on" : "");
    c.textContent = a.label;
    c.title = a.directive;
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
  void draftFor({ author: info?.author || "this post", text: outerText(el), context: quotedText(el), getEl: () => el, oppId: info?.id, angle: initialAngle(meta?.category), avatar: avatarUrl(el), products: meta?.products, name: displayName(el) });
}

function paintPanel(root: ShadowRoot, author: string, text: string, opts: { loading?: boolean; note?: string; draft?: string; angle?: string; avatar?: string; name?: string; products?: ProductItem[]; productIndex?: number; steer?: string }) {
  root.replaceChildren();
  const p = document.createElement("div"); p.className = "p";
  const h = document.createElement("div"); h.className = "h";
  const th = document.createElement("div"); th.className = "th";
  if (opts.avatar) { const av = document.createElement("img"); av.className = "pav"; av.src = opts.avatar; av.alt = ""; av.referrerPolicy = "no-referrer"; av.onerror = () => av.remove(); th.append(av); }
  const t = document.createElement("div"); t.className = "t"; t.textContent = `Reply to ${opts.name || "@" + author}`;
  th.append(t);
  const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.onclick = dismissPanel;
  h.append(th, x);
  const ctx = document.createElement("div"); ctx.className = "ctx"; ctx.textContent = text;
  p.append(h, ctx, angleRow(opts.angle));
  if (opts.angle === "promote" && opts.products && opts.products.length) p.append(productRow(opts.products, opts.productIndex ?? 0));
  if (opts.loading) {
    const l = document.createElement("div"); l.className = "load"; l.textContent = "Drafting in your voice…"; p.append(l);
  } else if (opts.note) {
    const n = document.createElement("div"); n.className = "load"; n.textContent = opts.note; p.append(n);
  } else {
    const ta = document.createElement("textarea"); ta.className = "ta"; ta.rows = 5; ta.value = opts.draft ?? "";
    const insert = document.createElement("button"); insert.className = "b primary"; insert.textContent = "Insert into reply box";
    insert.style.width = "100%"; insert.style.marginTop = "10px"; insert.style.boxSizing = "border-box";
    insert.onclick = () => void doInsert(ta.value);
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
    const foot = document.createElement("div"); foot.className = "foot"; foot.textContent = "Inserts into X's reply box — you review and post. Never auto-posts.";
    p.append(ta, insert, steer, row, foot);
  }
  root.appendChild(p);
}

function toast(msg: string) {
  const host = document.createElement("div");
  Object.assign(host.style, { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: "2147483647", pointerEvents: "none" } as Partial<CSSStyleDeclaration>);
  const root = host.attachShadow({ mode: "closed" });
  const d = document.createElement("div");
  Object.assign(d.style, { background: "#1d1812", color: "#f3ead9", border: "0.5px solid rgba(214,154,92,.18)", borderRadius: "10px", padding: "10px 14px", font: "12.5px -apple-system, system-ui, sans-serif", maxWidth: "320px", boxShadow: "0 12px 40px rgba(0,0,0,.5)" } as Partial<CSSStyleDeclaration>);
  d.textContent = msg;
  root.appendChild(d);
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 6000);
}

/* ---------- opportunities dock (always-on, ranked top posts) ---------- */

const DOCK_CSS = `
.l { display:flex; align-items:center; gap:9px; background:#1d1812; color:#f3ead9; border:.5px solid rgba(214,154,92,.3); border-radius:14px;
     cursor:pointer; text-align:left; font:600 12px -apple-system,system-ui,sans-serif; padding:7px 14px 7px 9px;
     box-shadow:0 8px 28px rgba(0,0,0,.45); }
.l:hover { border-color:rgba(214,154,92,.55); }
.lgoobi { display:inline-flex; flex:0 0 auto; }
.ltext { display:flex; flex-direction:column; line-height:1.25; min-width:0; }
.ll1 { font-weight:600; color:#f3ead9; }
.ll2 { font-size:10.5px; font-weight:500; color:#8c7d68; margin-top:1px; }
.lavs { display:inline-flex; align-items:center; margin-left:10px; flex:0 0 auto; }
.lav { width:22px; height:22px; border-radius:50%; object-fit:cover; border:1.5px solid #1d1812; box-sizing:border-box; background:#221c15; }
.lav + .lav { margin-left:-9px; }
.lavinit { display:inline-flex; align-items:center; justify-content:center; font:700 9px -apple-system,system-ui,sans-serif; color:#fff; }
.lmore { display:inline-flex; align-items:center; justify-content:center; font:700 9px -apple-system,system-ui,sans-serif; color:#cbb89c; background:#2a2118; }
.d { width:452px; max-width:calc(100vw - 32px); max-height:80vh; display:flex; flex-direction:column; position:relative;
     background:#14110d; color:#f3ead9; border:.5px solid rgba(214,154,92,.18); border-radius:16px;
     font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif; box-shadow:0 16px 48px rgba(0,0,0,.55); }
.d.wide { width:min(680px, calc(100vw - 32px)); max-height:90vh; } /* the Post-ideas writing surface gets more room */
.d.wide .idea-ta { font-size:15px; }
.d.wide .dl { padding-bottom:18px; }
.dh { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:15px 16px 10px; flex:0 0 auto; }
.dtitle { font-weight:500; font-size:18px; letter-spacing:-.2px; }
.dsub { font-weight:400; font-size:11.5px; color:#8c7d68; margin-top:3px; }
.pace { font-weight:500; white-space:nowrap; cursor:default; }
.mom { padding:9px 14px 11px; border-bottom:.5px solid rgba(214,154,92,.1); flex:0 0 auto; }
.mom-top { display:flex; align-items:center; gap:9px; }
.mom-bar { flex:1; height:7px; border-radius:5px; background:rgba(214,154,92,.12); overflow:hidden; }
.mom-fill { height:100%; border-radius:5px; transition:width .6s ease, background .3s; }
.mom-label { font:600 11px -apple-system,system-ui,sans-serif; white-space:nowrap; }
.mom-cue { font-size:10.5px; color:#8c7d68; margin-top:6px; line-height:1.35; }
.mom-stat { font-size:10.5px; color:#8c7d68; margin-top:5px; }
.insight { border-bottom:.5px solid rgba(214,154,92,.1); }
.ins-head { display:flex; align-items:center; gap:8px; padding:9px 14px; cursor:pointer; user-select:none; }
.ins-ttl { font:600 12px -apple-system,system-ui,sans-serif; color:#3a3027; }
.ins-cnt { font-size:10px; color:#8c7d68; margin-left:auto; }
.ins-car { font-size:10px; color:#8c7d68; width:10px; text-align:center; }
.ins-body { padding:2px 14px 12px; }
.ins-trend { font-size:11px; color:#6fcf7f; margin:2px 0 8px; font-weight:500; }
.ins-learn { font-size:11px; color:#8c7d68; line-height:1.4; padding:4px 0; }
.ins-row { display:flex; align-items:center; gap:9px; padding:6px 0; }
.ins-av { width:24px; height:24px; border-radius:50%; flex:0 0 auto; object-fit:cover; background:rgba(214,154,92,.15); }
.ins-av-l { display:flex; align-items:center; justify-content:center; font:600 11px -apple-system,system-ui,sans-serif; color:#8c7d68; }
.ins-mid { flex:1; min-width:0; }
.ins-top { display:flex; align-items:center; gap:6px; }
.ins-h { font:600 12px -apple-system,system-ui,sans-serif; color:#3a3027; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:120px; }
.ins-ar { font-size:11px; color:#8c7d68; }
.ins-badge { font-size:9.5px; color:#6fcf7f; font-weight:600; white-space:nowrap; }
.ins-thin { font-size:9px; color:#a89a85; opacity:.8; }
.ins-meta { font-size:10px; color:#8c7d68; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
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
.scanb { background:none; border:.5px solid rgba(214,154,92,.32); color:${ACCENT}; border-radius:999px;
         font:500 12px -apple-system,system-ui,sans-serif; padding:6px 12px; cursor:pointer; white-space:nowrap; }
.scanb:hover { background:rgba(214,154,92,.10); } .scanb:disabled { opacity:.6; cursor:default; }
.iconb { background:none; border:.5px solid rgba(214,154,92,.18); color:#8c7d68; border-radius:8px;
         width:30px; height:30px; cursor:pointer; font-size:15px; line-height:1; flex:0 0 auto; }
.iconb:hover { background:#221c15; }
.kback { position:absolute; inset:0; z-index:5; }
.kmenu { position:absolute; top:50px; right:14px; z-index:6; background:#221c15; border:.5px solid rgba(214,154,92,.22);
         border-radius:11px; padding:5px; display:flex; flex-direction:column; gap:2px; min-width:152px; box-shadow:0 12px 32px rgba(0,0,0,.5); }
.kitem { background:none; border:0; color:#f3ead9; text-align:left; font:500 12.5px -apple-system,system-ui,sans-serif;
         padding:8px 10px; border-radius:7px; cursor:pointer; }
.kitem:hover { background:#2c241d; } .kitem:disabled { opacity:.5; cursor:default; }
.tabs { display:flex; gap:4px; padding:0 14px 10px; flex:0 0 auto; }
.tab { flex:1; border:.5px solid transparent; border-radius:9px; background:none; color:#8c7d68;
       font:500 11.5px -apple-system,system-ui,sans-serif; padding:7px 4px; cursor:pointer; white-space:nowrap; }
.tab:hover { color:#cbb89c; } .tab.on { background:rgba(214,154,92,.13); border-color:rgba(214,154,92,.32); color:#e7b277; }
.modes { display:flex; gap:6px; padding:2px 14px 10px; flex:0 0 auto; }
.mode { flex:1; border:.5px solid rgba(214,154,92,.22); border-radius:10px; background:none; color:#8c7d68; font:600 12px -apple-system,system-ui,sans-serif; padding:8px 4px; cursor:pointer; }
.mode:hover { color:#cbb89c; }
.mode.on { background:${ACCENT}; border-color:transparent; color:${INK}; }
.ideas { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
.ideahead { padding:0 14px 9px; flex:0 0 auto; }
.ideasub { font-size:10.5px; color:#8c7d68; margin-top:6px; line-height:1.4; }
.idea { position:relative; display:flex; align-items:stretch; background:#1b150f; border:.5px solid rgba(214,154,92,.16); border-radius:12px; padding:0; margin-bottom:7px; cursor:pointer; overflow:hidden; transition:background .12s, border-color .12s; }
.idea:hover { background:#201a12; border-color:rgba(214,154,92,.28); }
.idea.open { cursor:default; background:#1d1710; border-color:rgba(214,154,92,.34); flex-wrap:wrap; }
.idea.dimmed { opacity:.5; pointer-events:none; }
.idea-pip { flex:0 0 4px; align-self:stretch; background:rgba(214,154,92,.18); }
.idea.kept .idea-pip { box-shadow:inset 2px 0 0 ${ACCENT}; }
.idea-main { flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:3px; padding:11px 6px 11px 9px; }
.idea-hook { font:600 13px -apple-system,system-ui,sans-serif; color:#f3ead9; line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.idea.open .idea-hook { white-space:normal; }
.idea-meta { font-size:10.5px; color:#8c7d68; line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.idea-meta b { font-weight:700; }
.idea.open .idea-meta { display:none; }
.idea-rowact { flex:0 0 auto; display:flex; align-items:center; gap:2px; padding:0 8px 0 2px; }
.idea-quickopen { border:0; background:none; color:${ACCENT}; font-size:15px; line-height:1; width:30px; height:30px; border-radius:8px; cursor:pointer; }
.idea-quickopen:hover { background:rgba(214,154,92,.14); }
.idea.open .idea-quickopen { display:none; }
.idea-chev { color:#8c7d68; font-size:11px; width:14px; text-align:center; transition:transform .15s; }
.idea.open .idea-chev { transform:rotate(90deg); }
.idea-body { flex-basis:100%; order:99; display:none; padding:2px 12px 12px 14px; }
.idea.open .idea-body { display:block; }
.idea-ta { width:100%; box-sizing:border-box; margin:0 0 2px; background:transparent; color:#f3ead9; border:0; border-bottom:1px solid transparent; border-radius:0; padding:0 0 4px; font:inherit; font-size:15px; line-height:1.6; resize:none; white-space:pre-wrap; min-height:44px; }
.idea-ta:focus { outline:none; border-bottom-color:rgba(214,154,92,.45); }
.idea-why { font-size:12px; color:#b6a892; margin-top:10px; line-height:1.5; }
.idea-src { font-size:10.5px; color:#8c7d68; margin-top:9px; }
.idea-srctog { cursor:pointer; }
.idea-srctog:hover { color:#cbb89c; }
.idea-quote { margin-top:7px; border-left:2px solid rgba(214,154,92,.3); padding:2px 0 2px 9px; }
.idea-qtext { font-size:11.5px; color:#b6a892; line-height:1.4; display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-wrap; }
.idea-qfoot { display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:10.5px; color:#8c7d68; }
.idea-qlink { color:${ACCENT}; text-decoration:none; }
.idea-actions { display:flex; gap:7px; align-items:center; margin-top:12px; }
.idea-open { border:0; border-radius:9px; padding:8px 14px; font:600 12px inherit; cursor:pointer; background:${ACCENT}; color:${INK}; }
.idea-open:hover { filter:brightness(1.06); }
.idea-copy { border:.5px solid rgba(214,154,92,.28); background:none; color:#cbb89c; border-radius:9px; padding:8px 12px; font:600 12px inherit; cursor:pointer; }
.idea-copy:hover { background:rgba(214,154,92,.1); color:#f3ead9; }
.idea-pin { margin-left:auto; border:.5px solid rgba(214,154,92,.22); background:none; color:#cbb89c; border-radius:9px; padding:6px 10px; cursor:pointer; font-size:12px; }
.idea-pin + .idea-pin { margin-left:0; }
.idea-pin.on { background:rgba(214,154,92,.14); border-color:transparent; color:${ACCENT}; }
.idea-trend { font-size:10.5px; color:#8c7d68; margin-top:6px; }
.idea-trend b { color:#cbb89c; }
.idea-streak { font:600 11.5px -apple-system,system-ui,sans-serif; color:#cbb89c; margin:0; }
.idea-streak b { color:${ACCENT}; }
.ideagate-t { font-weight:600; font-size:13.5px; color:#cbb89c; }
.idea.busy .idea-ta { opacity:.5; }
.idea.shipped { opacity:.85; }
.idea.shipped .idea-hook { color:#b6a892; }
.idea-steer { display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-top:10px; }
.idea-chip { border:.5px solid rgba(214,154,92,.25); background:#221c15; color:#cbb89c; border-radius:8px; font:600 10.5px -apple-system,system-ui,sans-serif; padding:4px 8px; cursor:pointer; }
.idea-chip:hover { background:rgba(214,154,92,.13); color:#f3ead9; }
.idea-undo { color:#8c7d68; }
.idea-steerin { flex:1; min-width:70px; background:#1a1510; color:#f3ead9; border:.5px solid rgba(214,154,92,.2); border-radius:8px; padding:4px 8px; font:inherit; font-size:11px; }
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
.df { margin:0 14px 8px; background:#221c15; border:.5px solid rgba(214,154,92,.18); border-radius:10px;
      color:#f3ead9; font:inherit; font-size:12.5px; padding:9px 12px; outline:none; flex:0 0 auto; }
.dl { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; padding:0; }
.it { display:flex; flex-direction:column; padding:13px 16px; border-top:.5px solid rgba(214,154,92,.10); }
.top { display:flex; gap:12px; }
.botacts { display:flex; align-items:center; gap:3px; flex-wrap:wrap; margin-top:11px; padding-top:10px; border-top:.5px solid rgba(214,154,92,.08); }
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
.rcol { flex:0 0 116px; display:flex; flex-direction:column; }
.rf { font-size:11px; color:#8c7d68; } .inf { cursor:default; }
.pct { font-size:32px; font-weight:600; line-height:1.02; margin-top:3px; font-variant-numeric:tabular-nums; }
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
.dhgoobi { flex:0 0 auto; cursor:pointer; }
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
.dpg-stage { position:relative; height:128px; border-radius:14px; background:#221c15; border:.5px solid rgba(214,154,92,.12); display:flex; align-items:flex-end; justify-content:center; padding-bottom:18px; cursor:pointer; }
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
`;

let dockHost: HTMLElement | null = null;
let dockRoot: ShadowRoot | null = null;
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

/** The known follower count for an opp's author, from a live lookup or (for
 *  search-discovered opps) the count the search response already carried. */
function knownFollowers(o: Opp): number | undefined {
  return authorReach.get(o.author.toLowerCase())?.followers ?? o.followers;
}

/** Queue a follower lookup for `handle` if we don't already have/aren't fetching
 *  it. Deduped, capped, and short-circuited when the X-data API isn't configured. */
function maybeFetchReach(handle?: string): void {
  if (invalidated || twttrUnconfigured || reachLookups >= REACH_CAP) return;
  const key = (handle || "").toLowerCase();
  if (!key) return;
  const e = authorReach.get(key);
  if (e && (e.pending || e.followers != null)) return;
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
    if (cur && cur.followers != null) continue;
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
      .finally(() => { reachInFlight--; renderDock(); pumpReach(); });
  }
}

/** True when the author is in the "punch up but reachable" zone: 5x–25x the
 *  user's own following. Replying under these gets real new-audience exposure
 *  without being one of thousands of replies on a mega-account. */
function inReachSweetSpot(o: Opp): boolean {
  const f = knownFollowers(o);
  if (!myFollowers || !f) return false;
  const r = f / myFollowers;
  return r >= 5 && r <= 25;
}

/** Reply-back proxy from the author's following/followers ratio (the cheapest
 *  signal for the ~75 author-reply-back weight, and it's already in the /user
 *  response we fetch for reach). An account that follows back a real fraction of
 *  its audience engages; a pure broadcaster almost never replies to a stranger.
 *  Neutral (1) when `following` isn't known yet (e.g. search-seeded opps). */
function reciprocityFactor(o: Opp): number {
  const e = authorReach.get(o.author.toLowerCase());
  const f = e?.followers ?? o.followers;
  const fr = e?.following;
  if (!f || fr == null) return 1;
  const ratio = fr / Math.max(f, 1);
  if (ratio >= 0.5) return 1.08;  // follows back heavily — very reply-prone
  if (ratio >= 0.1) return 1.04;  // healthy two-way account
  if (ratio < 0.02) return 0.92;  // pure broadcaster — rarely replies to randoms
  return 1;
}

/** Audience factor for effectiveScore. Real follower count when known (lifts
 *  bigger audiences, with a sweet-spot bump, a mega-account discount, and a
 *  reciprocity nudge), else the on-page likes proxy. */
function reachFactor(o: Opp): number {
  const f = knownFollowers(o);
  if (f && f > 0) {
    let r = Math.min(1.2, Math.max(0.5, 0.55 + Math.log10(f + 1) * 0.11)); // 1k:0.88 10k:0.99 100k:1.1 1M:1.2
    if (myFollowers > 0) {
      const ratio = f / myFollowers;
      if (ratio >= 5 && ratio <= 25) r *= 1.08;   // sweet spot
      else if (ratio > 500) r *= 0.94;            // you'd be buried among the replies
    }
    return Math.min(1.3, r * reciprocityFactor(o));
  }
  return o.likes ? Math.min(1.2, 0.6 + Math.log10(o.likes + 1) * 0.12) : 0.7;
}

/** Reply-worthiness RIGHT NOW = content/fit (the model score) × how live the
 *  window is. Timing dominates by design: on X, only the first ~5-10 replies in
 *  the first ~15 min get seen, so a fresh fast-rising post must outrank a stale
 *  great one. Multiplicative, recomputed live (postedAt is absolute), so a spot
 *  visibly decays as it ages. Reach (audience) lifts; reply-pileup buries. */
function freshnessFactor(postedAt?: number): number {
  if (!postedAt) return 0.5; // unknown age — neutral
  const m = (Date.now() - postedAt) / 60_000; // minutes old
  if (m < 5) return 1;
  if (m < 15) return 0.92;
  if (m < 30) return 0.78;
  if (m < 60) return 0.6;
  if (m < 180) return 0.42;
  if (m < 720) return 0.28; // <12h
  if (m < 1440) return 0.16; // <24h
  return 0.08;
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

function effectiveScore(o: Opp): number {
  const reach = reachFactor(o); // real follower count when known (Twttr), else the on-page likes proxy
  let buried = 1;
  if (o.likes && o.replies) {
    const ratio = o.replies / (o.likes + 1); // many replies per like = pile-on you get lost in
    buried = ratio > 1.5 ? 0.7 : ratio > 0.7 ? 0.85 : 1;
  } else if (o.replies && o.replies > 300) buried = 0.8;
  const fresh = freshnessFactor(o.postedAt);
  let s = o.score * fresh * reach * buried;
  // Community lift: a peer/builder in your space is worth replying to even when the
  // POST isn't on your niche topic — engaging peers compounds your community. Lift
  // them; and floor a FRESH niche-peer so a low topic-fit score can't bury them.
  const tier = builderTierFor(o);
  if (tier) s *= tier === 2 ? 1.25 : 1.12;
  if (tier === 2 && fresh >= 0.6) s = Math.max(s, 0.45);
  return Math.max(0, Math.min(1, s));
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
type DockView = "replies" | "ideas"; // top-level dock mode: reply opportunities vs original post ideas
let dockView: DockView = "replies";
interface IdeaSource { handle: string; id: string; text: string; likes?: number; reposts?: number; } // the real over-performing post we remixed
interface IdeaRecord {
  id: string; text: string; source: string; pattern: string; why: string; virality: number;
  src?: IdeaSource; pinned?: boolean; status: "working" | "posted";
  createdAt: number; lastEditedAt: number; postedAt?: number;
}
let ideaQueue: IdeaRecord[] = [];          // persisted drafts queue (X_IDEAS_KEY): working drafts + shipped
const expandedIdeas = new Set<string>();   // idea ids expanded into the in-place editor (single-open)
const expandedSources = new Set<string>(); // idea ids whose source-post proof is expanded
const ideaBusy = new Set<string>();        // ids currently being rewritten (per-idea steer)
const ideaUndo = new Map<string, string>(); // id → prior text, for one-level undo after a steer
let shippedOpen = false;                   // the collapsed "Shipped" section
let ideaSeq = 0;
let ideasLoading = false;
let ideasError: string | undefined;
const IDEAS_MAX = 30;
function newIdeaId(): string { return "i" + Date.now().toString(36) + (ideaSeq++).toString(36); }
function persistIdeas(): void {
  if (ideaQueue.length > IDEAS_MAX) { // prune oldest, keeping working over posted
    ideaQueue.sort((a, b) => (a.status === "working" ? 1 : 0) - (b.status === "working" ? 1 : 0) || a.createdAt - b.createdAt);
    ideaQueue = ideaQueue.slice(ideaQueue.length - IDEAS_MAX);
  }
  safeSet({ [CONFIG.X_IDEAS_KEY]: ideaQueue });
}
let goobiIdeasHandle: GoobiHandle | null = null; // the big dancing Goobi shown while ideas generate
let goobiIdeasTimer: number | undefined;
let kebabOpen = false; // the ⋮ overflow menu (Pause / Find spots / Clear all)
let insightOpen = false; // the "who you show up with" learning panel (collapsed by default)
let supportersOpen = false; // the "who shows up for you" reciprocity panel (collapsed by default)

let goobiReactUntil = 0;                          // transient reaction window (happy/cheer)
let goobiReactMood: GoobiMood = "happy";
let goobiReactCopy: [string, string] = ["Nice reply!", "that's the good stuff"];
let goobiSearchUntil = 0;                         // "searching" window after a manual rescan
let goobiLastSeen = 0;                            // last active use (persisted)
let goobiWelcomeBack = false;                     // set at boot when you've been away a while
let goobiDrafting = false;                        // a reply is being drafted (Claude)
let goobiDockHandle: GoobiHandle | null = null;   // the live dock/pill Goobi, for in-place mood updates
const DAY_MS = 24 * HOUR_MS;

function repliesLastHour(): number { return replyLog.times.filter((t) => Date.now() - t < HOUR_MS).length; }

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
  if (repliesLastHour() >= REPLY_HARD_PER_HOUR) return "worn";    // ease-off — honest mirror
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
  const key = (o: Opp): number =>
    dockSort === "recent" ? (o.postedAt ?? 0) :
    dockSort === "reach" ? (knownFollowers(o) ?? 0) :
    dockSort === "easy" ? easyScore(o) :
    effectiveScore(o);
  return list.sort((a, b) => key(b) - key(a)).slice(0, 25);
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
  const ranked = [...opps.values()].sort((a, b) => effectiveScore(b) - effectiveScore(a));
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
  for (const o of items) {
    maybeFetchReach(o.author); // enrich with the author's real follower count (best-effort)
    const it = document.createElement("div"); it.className = "it";
    const top = document.createElement("div"); top.className = "top";

    // Avatar (image, or a colored initial).
    if (o.avatar) {
      const av = document.createElement("img"); av.className = "av"; av.src = o.avatar; av.alt = ""; av.loading = "lazy"; av.referrerPolicy = "no-referrer";
      av.onerror = () => av.replaceWith(avInitial(o));
      top.append(av);
    } else { top.append(avInitial(o)); }

    const body = document.createElement("div"); body.className = "bodywrap";
    const main = document.createElement("div"); main.className = "main";

    // Name (+ verified badge) + follower count, right on the name line.
    const nm = document.createElement("div"); nm.className = "nm";
    const ns = document.createElement("span"); ns.className = "nmt"; ns.textContent = o.name || `@${o.author}`; ns.title = `@${o.author}`; nm.append(ns);
    if (o.verified) { const vb = document.createElement("span"); vb.className = "vf"; vb.textContent = "✓"; vb.title = "Verified account"; nm.append(vb); }
    const fc = knownFollowers(o);
    if (fc) { const fcs = document.createElement("span"); fcs.className = "fc"; fcs.textContent = `${fmtCount(fc)} followers`; nm.append(fcs); }
    main.append(nm);

    // Category chip + age — up near the name, above the text.
    const meta = document.createElement("div"); meta.className = "meta";
    if (o.source === "search") { const s = document.createElement("span"); s.className = "srch"; s.textContent = "🔎"; s.title = "Found via niche search (off your current page)"; meta.append(s); }
    if (o.category) { const cc = catColor(o.category); const ct = document.createElement("span"); ct.className = "chip"; ct.style.background = cc.bg; ct.style.color = cc.fg; ct.textContent = catLabel(o.category); meta.append(ct); }
    const btier = builderTierFor(o);
    if (btier) { const bc = document.createElement("span"); bc.className = "chip"; bc.style.background = "rgba(93,202,165,.16)"; bc.style.color = "#5dcaa5"; bc.textContent = btier === 2 ? "peer · your space" : "peer builder"; bc.title = "A builder/peer in your space — replying builds your community, even when the post isn't on your exact topic."; meta.append(bc); }
    const age = fmtAge(o.postedAt);
    if (age) meta.append(document.createTextNode((o.category ? " · " : "") + age));
    if (o.category === "promote") for (const p of o.products || []) { const ic = faviconImg(p.url) || letterAvatar(p.name); ic.title = p.name; meta.append(ic); }
    main.append(meta);

    // Post text.
    const ix = document.createElement("div"); ix.className = "ix"; ix.textContent = o.text; main.append(ix);

    // Why this.
    if (o.reason) {
      const why = document.createElement("div"); why.className = "why";
      const star = document.createElement("span"); star.className = "wst"; star.textContent = "✦";
      const lbl = document.createElement("b"); lbl.textContent = "Why this: ";
      const span = document.createElement("span"); span.append(lbl, document.createTextNode(o.reason));
      why.append(star, span); main.append(why);
    }
    body.append(main);

    // Right column — reply fit + actions.
    const rcol = document.createElement("div"); rcol.className = "rcol";
    const es = effectiveScore(o); const v = scoreVerdict(es);
    const rf = document.createElement("div"); rf.className = "rf";
    const inf = document.createElement("span"); inf.className = "inf"; inf.textContent = "ⓘ"; inf.title = "Reply fit: how worth replying to right now — content fit + freshness + reach, minus reply-pileup and engagement bait.";
    rf.append(document.createTextNode("Reply fit "), inf); rcol.append(rf);
    const pct = document.createElement("div"); pct.className = "pct"; pct.textContent = `${Math.round(es * 100)}%`; pct.style.color = v.color; rcol.append(pct);
    const vd = document.createElement("div"); vd.className = "vd"; vd.style.color = v.color;
    vd.textContent = inReachSweetSpot(o) ? `${v.label} · ◎ in reach` : v.label;
    vd.title = inReachSweetSpot(o) ? "In reach: this account is 5-25x your size — a reply reaches a bigger, still-attainable audience." : "";
    rcol.append(vd);

    const acts = document.createElement("div"); acts.className = "acts";
    const draft = document.createElement("button"); draft.className = "draftb"; draft.textContent = "✎ Draft reply";
    draft.onclick = () => void draftFor({ author: o.author, text: o.text, context: o.context, getEl: () => findPost(o.id, o.source === "search" ? undefined : o.text), oppId: o.id, angle: initialAngle(o.category), avatar: o.avatar, products: o.products, name: o.name });
    acts.append(draft);
    rcol.append(acts);
    body.append(rcol);
    top.append(body);
    it.append(top);

    // Bottom action row — Follow / Open on X / Skip / Mark commented.
    const bot = document.createElement("div"); bot.className = "botacts";
    const follow = document.createElement("button"); follow.className = "lk";
    const isFollowed = followed.has(o.author);
    follow.textContent = isFollowed ? "✓ Following" : "+ Follow";
    follow.disabled = isFollowed;
    follow.onclick = async () => {
      follow.disabled = true; follow.textContent = "Following…";
      const r = await followAuthor(findPost(o.id, o.source === "search" ? undefined : o.text));
      if (r === "followed") { followed.add(o.author); follow.textContent = "✓ Following"; toast(`Followed @${o.author}.`); touchGoobi(); goobiReact("happy", "New friend!", `following @${o.author}`, 2000); }
      else if (r === "already") { followed.add(o.author); follow.textContent = "✓ Following"; toast(`Already following @${o.author}.`); }
      else if (r === "paced") { follow.disabled = false; follow.textContent = "+ Follow"; toast("Slow down on follows — X flags rapid follows. Give it a minute."); }
      else { follow.disabled = false; follow.textContent = "+ Follow"; toast("Couldn't follow — open the post (↗), then use its ••• menu."); }
    };
    const open = document.createElement("button"); open.className = "lk"; open.textContent = "↗ Open on X"; open.title = "Open the post on X";
    open.onclick = () => window.open(`https://x.com/${o.author}/status/${o.id}`, "_blank", "noopener");
    const commented = document.createElement("button"); commented.className = "lk"; commented.textContent = "✓ Commented";
    commented.title = "Mark as commented — counts it toward today's replies and removes it from the list.";
    commented.onclick = () => { opps.delete(o.id); recordSentReply("", o); toast("Marked as commented."); };
    const skip = document.createElement("button"); skip.className = "lk skip"; skip.textContent = "✕ Skip"; skip.title = "Skip — remove from the list (doesn't count)";
    skip.onclick = () => { opps.delete(o.id); renderDock(); };
    bot.append(follow, open, commented, skip);
    it.append(bot);

    list.appendChild(it);
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
  if (stage && typeof b.animate === "function") {
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

  const stage = document.createElement("div"); stage.className = "dpg-stage"; stage.title = "Tap to pet Goobi";
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
  if (typeof panel.animate !== "function") return;
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
  if (typeof panel.animate !== "function") { done(); return; }
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

/** The best PATTERNS to remix: recent original niche posts that punch above their
 *  weight (engagement per √followers, with a noise floor) — a small account's genuine
 *  breakout beats a mega-account's floor post. ≤2 per author so it's not one voice. */
function pickBest(tweets: TwttrTweet[], max: number): TwttrTweet[] {
  const now = Date.now();
  const ranked = tweets
    .filter((t) => t.author && t.text && !t.isReply && t.text.length >= 40) // real posts, not one-liners / replies
    .filter((t) => !t.postedAt || now - t.postedAt < 120 * DAY_MS)          // not ancient
    .map((t) => {
      const eng = (t.likes ?? 0) + (t.reposts ?? 0);
      const f = t.followers ?? 0;
      const rate = f > 0 ? eng / Math.sqrt(f) : eng / 50; // "above their weight"; raw-ish when followers unknown
      return { t, eng, score: rate * Math.log10(eng + 10) }; // log keeps absolute pull mattering, not just rate
    })
    .filter((x) => x.eng >= 25)
    .sort((a, b) => b.score - a.score);
  const out: TwttrTweet[] = []; const perAuthor = new Map<string, number>();
  for (const { t } of ranked) {
    const k = t.author.toLowerCase(); const c = perAuthor.get(k) ?? 0;
    if (c >= 2) continue;
    perAuthor.set(k, c + 1); out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/* ---------- de-dupe (don't repeat the user's own posts, or each other) ---------- */
const IDEA_STOP = new Set("a an and the to of in on for is it its i you we my our your they that this with as at be or but so".split(" "));
function ideaTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !IDEA_STOP.has(w)));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
const TOO_SIMILAR = 0.5; // ≥50% shared content words = the same post, reworded

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
  return cache;
}
async function getOwnPosts(): Promise<string[]> {
  const handle = await myHandle();
  if (!handle) return [];
  const cached = (await getLocal(CONFIG.X_MY_POSTS_KEY)) as OwnPostsCache | undefined;
  if (cached && cached.handle === handle && Date.now() - cached.at < OWN_POSTS_TTL) { ownStats = cached.stats ?? ownStats; return cached.posts; }
  const fresh = await fetchOwnData(handle);
  return fresh ? fresh.posts : cached?.handle === handle ? cached.posts : [];
}
/** Refresh the real "views today" stat (60-min TTL). Fired on dock open; re-renders on change. */
async function refreshOwnStats(): Promise<void> {
  if (invalidated) return;
  const handle = await myHandle();
  if (!handle) { if (ownStats) { ownStats = undefined; renderDock(); } return; }
  const cached = (await getLocal(CONFIG.X_MY_POSTS_KEY)) as OwnPostsCache | undefined;
  if (cached && cached.handle === handle && Date.now() - cached.at < OWN_STATS_TTL) { ownStats = cached.stats; return; }
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

/* ---- Engagement learning loop ("who you show up with" + the Tier-2 measure-pass) ----
 * A once-a-day, dayKey-gated pass that (A) folds your own posts' real view-growth into a
 * bounded trend, and (B) fetches the real engagement your recent replies earned
 * (user-replies-v2), matches each back to a stored reply by text, and writes it into the
 * dormant SentRecord.outcome slot. Per-account aggregates are recomputed LIVE from the
 * reply log (idempotent) — only the own-post trend + scan gates persist. */
const LEARN_SCAN_ENABLED = true;   // the once-daily API fetch (Tier-1 ranking itself needs no fetch)
const SETTLE_DAYS = 2;             // freeze a reply's measured outcome once it's this old
interface DailySnap extends DailyDelta { day: string; }
interface LearnStore { handle: string; scanDay: string; measureDay?: string; restId?: string; prevById: Record<string, PostMetrics>; snaps: Record<string, DailySnap>; }
function freshLearn(handle: string): LearnStore { return { handle, scanDay: "", prevById: {}, snaps: {} }; }
let learn: LearnStore = freshLearn("");
let learnBusy = false;
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
  if (!replyLog.sent.length) { learn.measureDay = today; return; }
  let restId = learn.restId;
  if (!restId) {
    const ures = await send<{ ok?: boolean; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "user", query: { username: handle }, intent: true });
    if (ures?.error === "no-twttr-config") { twttrUnconfigured = true; return; } // no key → stop trying until settings change
    const u = ures?.ok ? parseUser(ures.data) : null;
    if (!u?.id) return; // couldn't resolve rest_id — retry next day, don't burn the gate
    restId = u.id;
  }
  const rres = await send<{ ok?: boolean; data?: unknown; error?: string }>({ type: "TWTTR_GET", path: "user-replies-v2", query: { user: restId, count: "40" }, intent: true });
  if (rres?.error === "no-twttr-config") { twttrUnconfigured = true; return; }
  if (!rres?.ok) return; // budget/HTTP error — retry next day
  const fetched: FetchedReply[] = parseTimelineTweets(rres.data)
    .filter((t) => t.isReply && t.text)
    .map((t) => ({ text: t.text, at: t.postedAt, likes: t.likes, replies: t.replies }));
  const now = Date.now();
  let wrote = 0;
  for (const mt of matchOutcomes(fetched, replyLog.sent)) {
    const rec = replyLog.sent[mt.index];
    if (!rec || rec.outcome?.frozen) continue; // frozen = settled, never re-touch
    rec.outcome = { at: now, likes: mt.likes, replies: mt.replies, frozen: now - rec.at >= SETTLE_DAYS * 24 * HOUR_MS };
    wrote++;
  }
  learn.restId = restId;
  learn.measureDay = today;
  if (wrote) safeSet({ [CONFIG.X_REPLY_LOG_KEY]: replyLog });
  safeSet({ [CONFIG.X_LEARN_STATS_KEY]: learn });
}
/** The once-daily learning pass, dayKey-gated + idempotent. Fired on dock open. */
async function maybeRunDailyLearn(): Promise<void> {
  if (invalidated || paused || learnBusy || !LEARN_SCAN_ENABLED || twttrUnconfigured) return;
  const handle = await myHandle();
  if (!handle) return;
  if (learn.handle !== handle) learn = freshLearn(handle); // handle switch → reset the trend
  const today = dayKey(Date.now());
  if (learn.scanDay === today && learn.measureDay === today) return; // both done for the day
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
        learn.snaps[day2] = { day: day2, ...delta };
        learn.prevById = nextPrev;
        learn.scanDay = day2;
        pruneSnaps(learn.snaps);
        safeSet({ [CONFIG.X_LEARN_STATS_KEY]: learn });
      }
    }
    // (B) Tier-2 measure-pass — the real engagement your replies earned.
    if (learn.measureDay !== today) await runMeasurePass(handle, today);
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
    pushInbound({ at: postedAtMs(el) ?? Date.now(), handle: info.author, kind, postId: info.id, avatar: avatarUrl(el), name: displayName(el), key });
    added++;
  });
  if (added) { schedulePersistInbound(); if (dockOpen) renderDock(); } // debounced write; only repaint when the dock is open
}

/** The most recent avatar/display we've seen for a handle (for the insight rows). */
function lastSeenFor(handle: string): string | undefined {
  for (let i = replyLog.sent.length - 1; i >= 0; i--) { const s = replyLog.sent[i]; if (s.author === handle && s.avatar) return s.avatar; }
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
function renderInsightPanel(d: HTMLElement): void {
  const now = Date.now();
  const agg = aggregateAccounts(replyLog.sent, now);
  const { ranked, learning } = rankAccounts(agg);
  const wrap = document.createElement("div"); wrap.className = "insight";

  const head = document.createElement("div"); head.className = "ins-head";
  head.onclick = () => { insightOpen = !insightOpen; renderDock(); };
  const ttl = document.createElement("div"); ttl.className = "ins-ttl"; ttl.textContent = "Who you show up with";
  const car = document.createElement("div"); car.className = "ins-car"; car.textContent = insightOpen ? "▾" : "▸";
  const cnt = document.createElement("div"); cnt.className = "ins-cnt";
  cnt.textContent = agg.attributed < GLOBAL_THIN ? "learning" : `${ranked.length} top`;
  head.append(ttl, cnt, car); wrap.append(head);

  if (insightOpen) {
    const body = document.createElement("div"); body.className = "ins-body";
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
        meta.textContent = `${r.replies} ${r.replies === 1 ? "reply" : "replies"} · last ${days}d` + (r.followers ? ` · ${fmtCount(r.followers)} followers` : "");
        meta.title = "Replies you inserted through Goobi" + (r.followers ? "; their follower count when you replied — not a reach estimate." : ".");
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
  // Cheap header signal only (no grouping/fuse) — the full aggregation runs only when open.
  let scored = 0; const seenHandles = new Set<string>();
  for (const e of inbound) if (e.kind === "reply" || e.kind === "mention") { scored++; seenHandles.add(e.handle); }

  const wrap = document.createElement("div"); wrap.className = "insight";
  const head = document.createElement("div"); head.className = "ins-head";
  head.onclick = () => { supportersOpen = !supportersOpen; renderDock(); };
  const ttl = document.createElement("div"); ttl.className = "ins-ttl"; ttl.textContent = "Who shows up for you";
  const car = document.createElement("div"); car.className = "ins-car"; car.textContent = supportersOpen ? "▾" : "▸";
  const cnt = document.createElement("div"); cnt.className = "ins-cnt"; cnt.textContent = scored < SUP_GLOBAL_THIN ? "learning" : `${seenHandles.size} ${seenHandles.size === 1 ? "acct" : "accts"}`;
  head.append(ttl, cnt, car); wrap.append(head);

  if (supportersOpen) {
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

async function generateIdeas() {
  if (ideasLoading) return;
  const niche = xNiche.trim();
  if (!niche) { toast("Set your niche in the Goobi panel so it knows your space."); return; }
  ideasLoading = true; ideasError = undefined; renderDock();
  goobiDrafting = true; refreshGoobi(); // Goobi thinks while Claude writes ideas
  try {
    const search = await send<{ ok?: boolean; status?: number; data?: unknown; error?: string }>({
      type: "TWTTR_GET", path: "search-v3", query: { type: "Top", count: "40", query: niche.slice(0, 120) }, intent: true,
    });
    if (search?.error === "no-twttr-config") { ideasError = "Add your RapidAPI key in the Goobi panel to gather niche posts."; return; }
    if (search?.error?.startsWith("budget-")) { ideasError = "Monthly X-data budget nearly used — ideas are paused. It resets on the 1st."; return; }
    if (!search?.ok) { ideasError = `Couldn't pull niche posts${search?.status ? ` (HTTP ${search.status})` : ""}. Try again.`; return; }
    const winners = pickBest(parseTimelineTweets(search.data), 10);
    if (!winners.length) { ideasError = "Didn't find strong posts in your niche to remix. Try a broader niche."; return; }
    const ownPosts = await getOwnPosts(); // cheap (cached ~24h, [] if no handle) — de-dupe + voice ground truth
    const resp = await send<{ ideas?: { text: string; source: string; pattern: string; why: string; virality: number }[]; error?: string }>({
      type: "POST_IDEAS",
      posts: winners.map((t) => ({ author: t.author, text: t.text, likes: t.likes, reposts: t.reposts, followers: t.followers })),
      ownPosts,
    });
    if (resp?.error === "no-key") { ideasError = "Add your Anthropic key in the Goobi panel to write post ideas."; return; }
    if (!resp || resp.error || !resp.ideas?.length) { ideasError = resp?.error ? `Couldn't write ideas: ${resp.error}` : "Couldn't write ideas — try again."; return; }
    // Attach the REAL source post (already fetched in `winners`) by matching the handle Claude cited.
    const now = Date.now();
    const fresh: IdeaRecord[] = resp.ideas.map((d) => {
      const w = d.source ? winners.find((x) => x.author.toLowerCase() === d.source.toLowerCase()) : undefined;
      return { id: newIdeaId(), text: d.text, source: d.source, pattern: d.pattern, why: d.why, virality: d.virality,
        src: w ? { handle: w.author, id: w.id, text: w.text, likes: w.likes, reposts: w.reposts } : undefined,
        status: "working", createdAt: now, lastEditedAt: now };
    });
    // Safety net: drop a fresh idea that duplicates one of YOUR recent posts, or an earlier sibling.
    const ownTok = ownPosts.map(ideaTokens); const keptTok: Set<string>[] = [];
    const deduped = fresh.filter((rec) => {
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

function viralityVerdict(v: number): { label: string; color: string } {
  if (v >= 70) return { label: "Strong", color: "#6fcf7f" };
  if (v >= 45) return { label: "Solid", color: "#e0a45c" };
  return { label: "Niche", color: "#8c7d68" };
}
function togglePin(rec: IdeaRecord): void { rec.pinned = !rec.pinned; rec.lastEditedAt = Date.now(); persistIdeas(); renderDock(); }
function markPosted(rec: IdeaRecord, posted: boolean): void {
  rec.status = posted ? "posted" : "working";
  rec.postedAt = posted ? Date.now() : undefined;
  if (posted) goobiReact("cheer", "Shipped! 🎉", "keep the streak alive", 3200);
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
  return ideaQueue.filter((i) => i.status === "working")
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.createdAt - a.createdAt || b.virality - a.virality);
}
function postedIdeas(): IdeaRecord[] { return ideaQueue.filter((i) => i.status === "posted").sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0)); }

/** Rewrite ONE idea per a steer, in place — a single scoped Claude call, with one-level undo. */
async function rewriteIdea(rec: IdeaRecord, steer: string): Promise<void> {
  if (ideaBusy.has(rec.id) || !steer.trim()) return;
  ideaBusy.add(rec.id); goobiDrafting = true; refreshGoobi(); renderDock();
  const prior = rec.text;
  const resp = await send<{ text?: string; error?: string }>({ type: "POST_IDEA_REWRITE", text: rec.text, steer: steer.trim(), source: rec.src?.text, pattern: rec.pattern });
  ideaBusy.delete(rec.id); goobiDrafting = false; refreshGoobi();
  if (resp?.text) { ideaUndo.set(rec.id, prior); rec.text = resp.text; rec.lastEditedAt = Date.now(); persistIdeas(); }
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

/** The collapsible proof: the ACTUAL over-performing post this idea remixed. */
function sourceBlock(idea: IdeaRecord): HTMLElement {
  const wrap = document.createElement("div");
  if (!idea.src) {
    const s = document.createElement("div"); s.className = "idea-src";
    s.textContent = `↺ Pattern borrowed from your niche${idea.pattern ? ` · ${idea.pattern}` : ""}`;
    wrap.append(s); return wrap;
  }
  const open = expandedSources.has(idea.id);
  const tog = document.createElement("div"); tog.className = "idea-src idea-srctog";
  tog.textContent = `↺ Remixing @${idea.src.handle}'s post${idea.pattern ? ` · ${idea.pattern}` : ""}  ${open ? "▾" : "▸"}`;
  tog.onclick = () => { open ? expandedSources.delete(idea.id) : expandedSources.add(idea.id); renderDock(); };
  wrap.append(tog);
  if (open) {
    const q = document.createElement("div"); q.className = "idea-quote";
    const qt = document.createElement("div"); qt.className = "idea-qtext"; qt.textContent = idea.src.text; q.append(qt);
    const f = document.createElement("div"); f.className = "idea-qfoot";
    const eng = document.createElement("span"); eng.textContent = `❤ ${fmtCount(idea.src.likes) || 0} · 🔁 ${fmtCount(idea.src.reposts) || 0} on this one`;
    const link = document.createElement("a"); link.className = "idea-qlink"; link.textContent = "Open post ↗";
    link.href = `https://x.com/${idea.src.handle}/status/${idea.src.id}`; link.target = "_blank"; link.rel = "noopener";
    f.append(eng, link); q.append(f); wrap.append(q);
  }
  return wrap;
}

/** Open X's composer prefilled with the (edited) draft — you review + post. Marks shipped. */
function openInComposer(idea: IdeaRecord, shipped: boolean): void {
  window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(idea.text)}`, "_blank", "noopener");
  if (!shipped) markPosted(idea, true);
}
const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find(Boolean) || s;

/** A scannable idea ROW: virality rail + one-line hook + source meta + one-tap ↗. Click the
 *  row to expand IN PLACE into the editor (draft hero + why + steer + source + actions). */
function ideaCard(idea: IdeaRecord, opts?: { shipped?: boolean }): HTMLElement {
  const shipped = !!opts?.shipped;
  const open = expandedIdeas.has(idea.id);
  const vv = viralityVerdict(idea.virality);
  const c = document.createElement("div"); c.className = "idea";
  if (open) c.classList.add("open");
  if (idea.pinned && !shipped) c.classList.add("kept");
  if (shipped) c.classList.add("shipped");
  if (ideaBusy.has(idea.id)) c.classList.add("busy");
  // Click the collapsed row (or the hook when open) to toggle — single-open.
  c.onclick = () => { const was = expandedIdeas.has(idea.id); expandedIdeas.clear(); if (!was) expandedIdeas.add(idea.id); renderDock(); };

  // Left rail = virality (color is the calibrated band).
  const pip = document.createElement("div"); pip.className = "idea-pip"; pip.style.background = vv.color;
  pip.title = `Goobi's calibrated guess at how far this could spread (${idea.virality}/100). A hunch, not a promise.`;
  c.append(pip);

  // Main column — hook + meta (the scannable part).
  const main = document.createElement("div"); main.className = "idea-main";
  const hook = document.createElement("div"); hook.className = "idea-hook"; hook.textContent = firstLine(idea.text); main.append(hook);
  const meta = document.createElement("div"); meta.className = "idea-meta";
  const vl = document.createElement("b"); vl.textContent = vv.label; vl.style.color = vv.color; meta.append(vl);
  const tail = [idea.pattern, idea.src ? `↺ @${idea.src.handle}` : (!idea.pattern ? "↺ your niche" : "")].filter(Boolean).join(" · ");
  if (tail) meta.append(document.createTextNode(" · " + tail));
  main.append(meta); c.append(main);

  // Collapsed-row right actions — quick open + chevron.
  const rowact = document.createElement("div"); rowact.className = "idea-rowact";
  const quick = document.createElement("button"); quick.className = "idea-quickopen"; quick.textContent = "↗"; quick.title = "Open in X's composer — you review and post.";
  quick.onclick = (e) => { e.stopPropagation(); openInComposer(idea, shipped); };
  const chev = document.createElement("span"); chev.className = "idea-chev"; chev.textContent = "▸";
  rowact.append(quick, chev); c.append(rowact);

  // Expandable body — the editor.
  const body = document.createElement("div"); body.className = "idea-body";
  body.onclick = (e) => e.stopPropagation(); // editing must never collapse the card
  const ta = document.createElement("textarea"); ta.className = "idea-ta"; ta.value = idea.text;
  ta.rows = Math.min(10, Math.max(3, idea.text.split("\n").length + Math.ceil(idea.text.length / 42)));
  const autosize = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.oninput = () => { idea.text = ta.value; hook.textContent = firstLine(ta.value); autosize(); };
  ta.onchange = () => { idea.lastEditedAt = Date.now(); persistIdeas(); };
  body.append(ta);
  if (open) requestAnimationFrame(autosize); // size to content once it's visible
  if (idea.why) { const w = document.createElement("div"); w.className = "idea-why"; w.textContent = idea.why; body.append(w); }
  if (!shipped) body.append(steerRow(idea)); // quick-shape (working drafts only)
  body.append(sourceBlock(idea));            // the over-performing source post it remixed
  const actions = document.createElement("div"); actions.className = "idea-actions";
  const openBtn = document.createElement("button"); openBtn.className = "idea-open"; openBtn.textContent = "Open in composer ↗";
  openBtn.title = "Opens X's composer with your edited draft prefilled — you review and post (never auto-posts). Marks it shipped.";
  openBtn.onclick = () => openInComposer(idea, shipped);
  const copy = document.createElement("button"); copy.className = "idea-copy"; copy.textContent = "Copy";
  copy.onclick = async () => { try { await navigator.clipboard.writeText(idea.text); copy.textContent = "Copied ✓"; setTimeout(() => (copy.textContent = "Copy"), 1400); } catch { /* ignore */ } };
  actions.append(openBtn, copy);
  if (shipped) {
    const back = document.createElement("button"); back.className = "idea-pin"; back.textContent = "↩"; back.title = "Move back to working drafts (didn't post it)";
    back.onclick = () => markPosted(idea, false); actions.append(back);
  } else {
    const pin = document.createElement("button"); pin.className = "idea-pin" + (idea.pinned ? " on" : ""); pin.textContent = "📌";
    pin.title = idea.pinned ? "Kept — won't be replaced on a reroll." : "Keep this one — survives a reroll.";
    pin.onclick = () => togglePin(idea);
    const done = document.createElement("button"); done.className = "idea-pin"; done.textContent = "✓"; done.title = "I posted this (e.g. via Copy) — mark it shipped.";
    done.onclick = () => markPosted(idea, true);
    actions.append(pin, done);
  }
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

function buildIdeas(): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "ideas";
  // No-niche gate — without it, Generate is a no-op. Make that explicit, not a silent toast.
  if (!xNiche.trim()) {
    const head = document.createElement("div"); head.className = "ideahead";
    const gate = document.createElement("div"); gate.className = "idea-gate";
    const t = document.createElement("div"); t.className = "ideagate-t"; t.textContent = "Tell Goobi your niche first";
    const p = document.createElement("div"); p.className = "ideasub"; p.textContent = "That's how it knows whose posts to learn from. Open the Goobi side panel and set “What's worth replying to / your niche.”"; p.style.marginTop = "8px";
    gate.append(t, p); head.append(gate); wrap.append(head);
    return wrap;
  }
  const working = workingIdeas(); const posted = postedIdeas();
  const head = document.createElement("div"); head.className = "ideahead";
  // Row 1 — streak (left) + the Generate action anchored top-right (no longer buried mid-stack).
  const top = document.createElement("div"); top.className = "ideahead-top";
  const left = document.createElement("div");
  if (posted.length) {
    left.className = "idea-streak";
    const streak = postedStreak();
    left.append(document.createTextNode(`Shipped ${posted.length}`));
    if (streak) { left.append(document.createTextNode(" · ")); const b = document.createElement("b"); b.textContent = `🔥 ${streak}-day`; left.append(b); }
  }
  const gen = document.createElement("button"); gen.className = "scanb";
  gen.textContent = ideasLoading ? "Thinking…" : working.length ? "+ New batch" : "✨ Generate ideas";
  gen.disabled = ideasLoading; gen.onclick = () => void generateIdeas();
  top.append(left, gen); head.append(top);
  // Row 2 — sub + reach folded into one muted line.
  const sub = document.createElement("div"); sub.className = "ideasub";
  sub.textContent = "Remixes your niche's winning patterns into your voice — you review and post." + (myFollowers > 0 ? ` · tuned to ~${fmtCount(myFollowers)} followers` : "");
  head.append(sub);
  // Row 3 — winning shapes (optional).
  const pats = Array.from(new Set(working.map((i) => i.pattern).filter(Boolean))).slice(0, 3);
  if (pats.length) { const tr = document.createElement("div"); tr.className = "idea-trend"; tr.append(document.createTextNode("Winning shapes: ")); const b = document.createElement("b"); b.textContent = pats.join(" · "); tr.append(b); head.append(tr); }
  wrap.append(head);

  const body = document.createElement("div"); body.className = "dl";
  if (ideasLoading) {
    const stage = document.createElement("div"); stage.className = "idea-load"; // Goobi dances here (mounted after the dock is in the DOM)
    const cap = document.createElement("div"); cap.className = "idea-loadcap"; cap.textContent = "Reading the top posts in your niche, then writing in your voice…";
    body.append(stage, cap);
    for (const idea of working) { const card = ideaCard(idea); card.classList.add("dimmed"); body.append(card); } // your queue stays visible through a generate
  } else if (ideasError) {
    const err = document.createElement("div"); err.className = "idea-err";
    const et = document.createElement("div"); et.className = "idea-err-t"; et.textContent = ideasError; err.append(et);
    const retry = document.createElement("button"); retry.className = "scanb"; retry.textContent = "Try again"; retry.onclick = () => void generateIdeas(); err.append(retry);
    body.append(err);
  } else {
    if (!working.length && !posted.length) { const e = document.createElement("div"); e.className = "idea-empty"; e.textContent = "Tap Generate — Goobi finds what's working in your niche and remixes it into posts you can publish."; body.append(e); }
    else if (!working.length) { const e = document.createElement("div"); e.className = "idea-empty"; e.textContent = "Queue's clear — nice. Tap “+ New batch” for fresh ideas."; body.append(e); }
    for (const idea of working) body.append(ideaCard(idea));
    // Shipped — collapsed.
    if (posted.length) {
      const tog = document.createElement("div"); tog.className = "idea-shiptog"; tog.textContent = `${shippedOpen ? "▾" : "▸"} Shipped (${posted.length})`;
      tog.onclick = () => { shippedOpen = !shippedOpen; renderDock(); };
      body.append(tog);
      if (shippedOpen) for (const idea of posted) body.append(ideaCard(idea, { shipped: true }));
    }
  }
  wrap.append(body);
  return wrap;
}

function renderDock() {
  if (!enabled || invalidated) return;
  if (dockPlayOpen && dockRoot?.querySelector(".dplay")) return; // playground is live — ambient re-renders must not tear it down under the user
  const root = ensureDock();
  goobiDockHandle?.destroy(); goobiDockHandle = null; // stop the previous header Goobi before we rebuild (replaceChildren only detaches it)
  stopIdeasGoobi(); // the ideas-loading dancer (re-mounted below if still loading)
  root.replaceChildren();
  const n = opps.size;
  if (!dockOpen) {
    const { mood, line, sub } = goobiStatus();
    const l = document.createElement("button"); l.className = "l";
    l.title = `${line} — open Goobi`;
    l.onclick = () => {
      dockOpen = true;
      if (dockPlayOpen) resetPlay(); // always open onto the posts list, never a stale playground
      if (goobiWelcomeBack) { goobiWelcomeBack = false; goobiReact("cheer", "Missed you!", "glad you're back", 4000); }
      touchGoobi();
      // refreshOwnStats owns the single from:<handle> fetch; run it FIRST so the daily learn
      // pass reads a warm cache (no double-bill), then the once-a-day trend + measure-pass.
      void refreshOwnStats().catch(() => {}).then(() => { if (!invalidated) void maybeRunDailyLearn(); });
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
    root.appendChild(l);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(mood);
    return;
  }
  const d = document.createElement("div"); d.className = "d" + (dockView === "ideas" ? " wide" : "");
  const gstat = goobiStatus();
  const gh = document.createElement("div"); gh.className = "dhgoobi"; gh.title = `${gstat.line} — tap Goobi to play`; gh.onclick = () => togglePlay();
  const h = document.createElement("div"); h.className = "dh";
  const t = document.createElement("div"); t.className = "dt";
  const today = repliesToday();
  const sub = document.createElement("div"); sub.className = "dsub";
  const cnt = document.createElement("span");
  cnt.textContent = `${n} ready · ${today} sent today`;
  cnt.title = "Posts ready to reply to · replies you've inserted through Goobi today (resets at local midnight).";
  sub.append(cnt);
  // Live pace chip — surfaces the account-safety status in the moment you're replying.
  const rhh = replyLog.times.filter((tm) => Date.now() - tm < HOUR_MS).length;
  const stt = reputationStatus(rhh);
  const PACE_COLOR: Record<string, string> = { healthy: "#6fcf7f", caution: "#e89a3c", easeoff: "#d6604a" };
  const chip = document.createElement("span"); chip.className = "pace";
  if (paused) { chip.textContent = "⏸ paused"; chip.style.color = "#8c7d68"; chip.title = "The copilot is paused — no scanning, surfacing, or API calls."; }
  else { chip.style.color = PACE_COLOR[stt.level]; chip.textContent = `● ${stt.label}`; chip.title = `${rhh} repl${rhh === 1 ? "y" : "ies"} in the last hour. X reads ~30/hr as automated — Goobi keeps you under it.`; }
  sub.append(document.createTextNode(" · "), chip);
  t.append(sub);
  const dhl = document.createElement("div"); dhl.className = "dhl"; dhl.append(gh, t); // Goobi sits left of the title

  const acts = document.createElement("div"); acts.className = "da";
  if (!paused && !dockPlayOpen && dockView === "replies") {
    const re = document.createElement("button"); re.className = "scanb"; re.textContent = findingSpots ? "Searching…" : "↻ Scan again";
    re.title = "Rescan the page for new posts worth replying to";
    re.disabled = findingSpots;
    re.onclick = () => rescan();
    acts.append(re);
  }
  const kb = document.createElement("button"); kb.className = "iconb"; kb.textContent = "⋮"; kb.title = "More — pause, find spots, clear";
  kb.onclick = () => { kebabOpen = !kebabOpen; renderDock(); };
  acts.append(kb);
  const x = document.createElement("button"); x.className = "iconb"; x.textContent = "–"; x.title = "Minimize"; // collapses to the launcher pill — it minimizes, it doesn't close
  x.onclick = () => { kebabOpen = false; if (dockPlayOpen) resetPlay(); dockOpen = false; renderDock(); };
  acts.append(x);
  h.append(dhl, acts);
  d.append(h);

  // Warm-up / momentum strip — your pacing TODAY (peaks at healthy, overheats past the line),
  // reusing the SAME stt the pace chip read so they can never disagree. Real views ride beside it.
  {
    const lastReply = replyLog.times.length ? Math.max(...replyLog.times) : 0;
    const lastPost = ideaQueue.reduce((mx, i) => (i.postedAt && i.postedAt > mx ? i.postedAt : mx), 0);
    const lastAt = Math.max(lastReply, lastPost);
    const m = computeMomentum({
      repliesToday: repliesToday(), postedToday: postedToday(), replyStreak: replyStreak(),
      minsSinceLast: lastAt ? (Date.now() - lastAt) / 60000 : 9999, repLevel: stt.level,
    });
    const mom = document.createElement("div"); mom.className = "mom";
    const top = document.createElement("div"); top.className = "mom-top";
    const bar = document.createElement("div"); bar.className = "mom-bar";
    const fill = document.createElement("div"); fill.className = "mom-fill"; fill.style.width = m.score + "%"; fill.style.background = m.color;
    if (m.state === "peak") fill.style.boxShadow = `0 0 8px ${m.color}`;
    bar.append(fill);
    const lbl = document.createElement("div"); lbl.className = "mom-label"; lbl.textContent = m.label; lbl.style.color = m.color;
    top.append(bar, lbl);
    const cue = document.createElement("div"); cue.className = "mom-cue"; cue.textContent = m.cue;
    mom.append(top, cue);
    // Real X-reported views today — a neutral FACT (never colored/celebrated), only when we have the data.
    if (ownStats !== undefined) {
      const v = ownViewsToday();
      const stat = document.createElement("div"); stat.className = "mom-stat";
      stat.textContent = v.posts ? `◷ ${v.posts} post${v.posts === 1 ? "" : "s"} today${v.hasViews ? ` · ${fmtCount(v.views)} views` : ""}` : "No posts yet today";
      stat.title = "X-reported views on the posts you've shipped today, pulled from the X-data API. Refreshed on dock open (~hourly), not live.";
      mom.append(stat);
    }
    d.append(mom);
  }

  // Relationships: "Who you show up with" (you→them) + "Who shows up for you" (them→you).
  renderInsightPanel(d);
  renderSupportersPanel(d);

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
    item(findingSpots ? "Searching…" : "✦ Find spots", () => void findSpots(), paused || findingSpots);
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

  // Top-level mode: reply opportunities vs original post ideas.
  const modes = document.createElement("div"); modes.className = "modes";
  const mkMode = (id: DockView, label: string) => {
    const b = document.createElement("button"); b.className = "mode" + (dockView === id ? " on" : ""); b.textContent = label;
    b.onclick = () => { if (dockView !== id) { dockView = id; renderDock(); } };
    return b;
  };
  modes.append(mkMode("replies", "💬 Replies"), mkMode("ideas", "✨ Post ideas"));
  d.append(modes);

  if (dockView === "ideas") {
    d.append(buildIdeas());
    root.appendChild(d);
    goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(gstat.mood);
    mountIdeasGoobi(); // dance while ideas generate (after the dock is in the DOM)
    return;
  }

  // Sort tabs.
  const tabs = document.createElement("div"); tabs.className = "tabs";
  const TABS: { id: DockSort; label: string; title: string }[] = [
    { id: "best", label: "Best", title: "Best reply-fit first" },
    { id: "recent", label: "Recent", title: "Newest posts first" },
    { id: "reach", label: "High reach", title: "Biggest accounts first" },
    { id: "easy", label: "Easy replies", title: "Short, answerable posts you can reply to fast and early" },
  ];
  for (const td of TABS) {
    const tb2 = document.createElement("button"); tb2.className = "tab" + (dockSort === td.id ? " on" : ""); tb2.textContent = td.label; tb2.title = td.title;
    tb2.onclick = () => { if (dockSort !== td.id) { dockSort = td.id; renderDock(); } };
    tabs.append(tb2);
  }
  d.append(tabs);

  const f = document.createElement("input"); f.className = "df"; f.placeholder = "Filter posts…"; f.value = dockFilter;
  const list = document.createElement("div"); list.className = "dl";
  f.oninput = () => { dockFilter = f.value; renderList(list); };
  d.append(f, list);

  const foot = document.createElement("div"); foot.className = "foot";
  const f1 = document.createElement("div"); f1.className = "foot1"; f1.textContent = n ? "✦ You're all caught up" : "✦ Watching your feed";
  const f2 = document.createElement("div"); f2.className = "foot2"; f2.textContent = "We'll surface more great posts as you scroll.";
  foot.append(f1, f2);
  d.append(foot);

  root.appendChild(d);
  renderList(list);
  goobiDockHandle = mountGoobi(gh, { cell: 3 }); goobiDockHandle.setMood(gstat.mood); // Goobi lives at the top, mood-driven
}

/* ---------- boot + SPA route handling ---------- */

async function boot() {
  enabled = (await getLocal(CONFIG.X_COPILOT_KEY)) !== false; // default on
  if (!enabled) return;
  paused = (await getLocal(CONFIG.X_PAUSED_KEY)) === true; // default not paused
  const storedProducts = await getLocal(CONFIG.X_PRODUCTS_KEY);
  xProducts = Array.isArray(storedProducts) ? (storedProducts as ProductItem[]) : [];
  legacyProduct = ((await getLocal(CONFIG.X_PRODUCT_KEY)) as string) || "";
  xDefaultAngle = ((await getLocal(CONFIG.X_DEFAULT_ANGLE_KEY)) as string) || "";
  xDefaultProduct = ((await getLocal(CONFIG.X_DEFAULT_PRODUCT_KEY)) as string) || "";
  xNiche = ((await getLocal(CONFIG.X_NICHE_KEY)) as string) || "";
  myFollowers = Number(await getLocal(CONFIG.X_MY_FOLLOWERS_KEY)) || 0;
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
  if (storedOwn?.stats) ownStats = storedOwn.stats;
  const storedLearn = await getLocal(CONFIG.X_LEARN_STATS_KEY) as LearnStore | undefined; // engagement learning store (own-post trend + scan gates)
  if (storedLearn?.handle) learn = storedLearn;
  hydrateInbound(await getLocal(CONFIG.X_SUPPORTERS_KEY)); // who engages with me (reciprocity)
  void loadFavicons();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CONFIG.X_PRODUCTS_KEY]) { xProducts = (changes[CONFIG.X_PRODUCTS_KEY].newValue as ProductItem[]) || []; void loadFavicons(); renderDock(); }
    if (changes[CONFIG.X_PRODUCT_KEY]) legacyProduct = (changes[CONFIG.X_PRODUCT_KEY].newValue as string) || "";
    if (changes[CONFIG.X_DEFAULT_ANGLE_KEY]) xDefaultAngle = (changes[CONFIG.X_DEFAULT_ANGLE_KEY].newValue as string) || "";
    if (changes[CONFIG.X_DEFAULT_PRODUCT_KEY]) xDefaultProduct = (changes[CONFIG.X_DEFAULT_PRODUCT_KEY].newValue as string) || "";
    if (changes[CONFIG.X_NICHE_KEY]) xNiche = (changes[CONFIG.X_NICHE_KEY].newValue as string) || "";
    if (changes[CONFIG.X_PAUSED_KEY]) { const p = changes[CONFIG.X_PAUSED_KEY].newValue === true; if (p !== paused) { paused = p; if (p && dockPlayOpen) resetPlay(); renderDock(); if (!p) rescan(); } } // synced from the popup / another tab
    if (changes[CONFIG.X_MY_FOLLOWERS_KEY]) { myFollowers = Number(changes[CONFIG.X_MY_FOLLOWERS_KEY].newValue) || 0; renderDock(); }
    if (changes[CONFIG.X_LEARN_STATS_KEY]) { const nv = changes[CONFIG.X_LEARN_STATS_KEY].newValue as LearnStore | undefined; if (nv?.handle) { learn = nv; renderDock(); } } // synced from another tab's daily scan
    if (changes[CONFIG.X_SUPPORTERS_KEY]) { hydrateInbound(changes[CONFIG.X_SUPPORTERS_KEY].newValue); renderDock(); } // synced from another tab's notifications harvest (validated, not trusted raw)
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
    requestScan();
    renderDock();
  }, 700);

  scan();
}

const host = location.hostname;
if (window.top === window && /(^|\.)(x|twitter)\.com$/.test(host)) {
  void boot();
}
