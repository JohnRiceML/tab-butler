import { CONFIG } from "../lib/config";
import { REPLY_ANGLES } from "../lib/prompts";
import { parseUser, pickDiscoveryTweets } from "../lib/twttr";
import { isDuplicateReply, normalizeReply, pickReplyNudge, reputationStatus, REPLY_SOFT_PER_HOUR, REPLY_HARD_PER_HOUR } from "../lib/reply-hygiene";
import { humanDelayMs, jitterGap } from "../lib/human-pacing";
import { mountGoobi, type GoobiMood } from "../lib/goobi";
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
interface Opp { id: string; author: string; text: string; score: number; reason: string; context?: string; postedAt?: number; likes?: number; replies?: number; avatar?: string; category?: string; products?: ProductItem[]; name?: string; followers?: number; source?: "feed" | "search"; verified?: boolean; }
const opps = new Map<string, Opp>();
let dockOpen = false;
let dockFilter = "";

interface Queued { id: string; author: string; text: string; el: HTMLElement; }
const queue: Queued[] = [];
/** Posts sent to Claude and awaiting a score — guards against re-queueing the
 *  same post during the request window (e.g. a Rescan mid-flight). */
const inFlight = new Set<string>();

function getLocal(key: string): Promise<unknown> {
  return new Promise((res) => chrome.storage.local.get(key, (o) => res(o[key])));
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

/** Compact, human stats line shared by the dock display and the scorer prompt. */
function metaLine(s: PostStats): string | undefined {
  const parts: string[] = [];
  const age = fmtAge(s.postedAt); if (age) parts.push(`${age} old`);
  if (s.likes !== undefined) parts.push(`${fmtCount(s.likes)} likes`);
  if (s.replies !== undefined) parts.push(`${fmtCount(s.replies)} replies`);
  return parts.length ? parts.join(" · ") : undefined;
}

/* ---------- scan / score ---------- */

let scanPending = false;
function requestScan() {
  if (scanPending || !enabled) return;
  scanPending = true;
  requestAnimationFrame(() => { scanPending = false; scan(); });
}

function scan() {
  if (!enabled || paused) return;
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
    if (cached) { if (cached.score >= THRESHOLD) badge(el, cached.reason, cached.category); return; }
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
  if (!enabled || paused || scoreCalls >= MAX_SCORE_CALLS) return;
  const batch = queue.splice(0, BATCH).filter((q) => q.el.isConnected && !seen.has(q.id));
  if (!batch.length) return;
  scoreCalls++;
  const snap = batch.map((b) => ({ ...snapStats(b.el), avatar: b.el.isConnected ? avatarUrl(b.el) : undefined, name: b.el.isConnected ? displayName(b.el) : undefined, verified: b.el.isConnected ? isVerified(b.el) : undefined }));
  const posts = batch.map((b, i) => ({ i, author: b.author, text: b.text })); // content/fit only; timing+reach handled live by effectiveScore
  batch.forEach((b) => inFlight.add(b.id));
  const resp = await send<{ scores?: { i: number; score: number; reason: string; category?: string; products?: string[] }[]; error?: string }>({
    type: "SCORE_POSTS",
    posts,
  });
  batch.forEach((b) => inFlight.delete(b.id));
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
    if (s.score >= THRESHOLD) {
      opps.set(b.id, { id: b.id, author: b.author, text: b.text, score: s.score, reason, category, products, context: b.el.isConnected ? quotedText(b.el) : undefined, postedAt: stat.postedAt, likes: stat.likes, replies: stat.replies, avatar: stat.avatar, name: stat.name, verified: stat.verified });
      changed = true;
      if (statusInfo(b.el)?.id === b.id) badge(b.el, reason, category);
    } else {
      // Re-scored below threshold (e.g. after a Rescan): prune the stale spot + badge.
      if (opps.delete(b.id)) changed = true;
      if (b.el.isConnected) b.el.querySelector("[data-tbx-badge]")?.remove();
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
  void chrome.storage.local.set({ [CONFIG.X_PAUSED_KEY]: v }).catch(() => { /* best-effort */ });
  if (v) dismissPanel(); // close any open draft so nothing can be inserted while paused
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

function badge(el: HTMLElement, reason: string, category?: string) {
  const existing = el.querySelector<HTMLElement>("[data-tbx-badge]");
  if (existing) {
    // Already badged — refresh the label/tooltip only if the category changed
    // (e.g. a Rescan re-categorized it), so it never gets stuck on a stale value.
    if (existing.dataset.tbxCat !== (category || "")) {
      existing.dataset.tbxCat = category || "";
      existing.textContent = `✦ ${catLabel(category)}`;
      existing.title = reason;
    }
    return;
  }
  el.style.borderLeft = `3px solid ${ACCENT}`;
  el.style.borderTopLeftRadius = "4px";
  el.style.borderBottomLeftRadius = "4px";
  if (getComputedStyle(el).position === "static") el.style.position = "relative";

  const b = document.createElement("button");
  b.setAttribute("data-tbx-badge", "1");
  b.dataset.tbxCat = category || "";
  b.textContent = `✦ ${catLabel(category)}`;
  b.title = reason;
  Object.assign(b.style, {
    position: "absolute", top: "10px", right: "12px", zIndex: "9999",
    background: ACCENT, color: INK, border: "0", borderRadius: "999px",
    font: "600 11px -apple-system, system-ui, sans-serif", padding: "3px 10px", cursor: "pointer",
  } as Partial<CSSStyleDeclaration>);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    void openDraftFromEl(el);
  });
  el.appendChild(b);
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
`;

let panelHost: HTMLElement | null = null;
let panelRoot: ShadowRoot | null = null;
function ensurePanel(): ShadowRoot {
  if (panelHost?.isConnected && panelRoot) return panelRoot;
  panelHost = document.createElement("div");
  Object.assign(panelHost.style, { position: "fixed", bottom: "18px", right: "18px", zIndex: "2147483647" } as Partial<CSSStyleDeclaration>);
  panelRoot = panelHost.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(PANEL_CSS);
  panelRoot.adoptedStyleSheets = [sheet];
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
/** One sent reply's features — the raw material for the "what's working" learning
 *  loop. `outcome` is filled later by the (paced, API-backed) measure pass that
 *  matches this to your posted reply via /user-replies and reads its engagement. */
interface SentRecord {
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
  outcome?: { at: number; likes?: number; replies?: number; authorReplied?: boolean };
}
interface ReplyLog { times: number[]; authors: Record<string, number>; drafts: { norm: string; at: number }[]; daily: Record<string, number>; total: number; sent: SentRecord[]; }
let replyLog: ReplyLog = { times: [], authors: {}, drafts: [], daily: {}, total: 0, sent: [] };
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
interface DraftReq { author: string; text: string; context?: string; getEl?: () => HTMLElement | null; oppId?: string; angle?: string; avatar?: string; products?: ProductItem[]; productIndex?: number; name?: string; }
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

/** Append a feature record for the reply we just helped send — the raw material
 *  the "what's working" loop will later correlate with outcomes. */
function logSentReply(now: number, text: string, opp?: Opp, angle?: string): void {
  const rec: SentRecord = {
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
  };
  replyLog.sent.push(rec);
  if (replyLog.sent.length > SENT_MAX) replyLog.sent = replyLog.sent.slice(-SENT_MAX);
}

/** Record one reply the system handed you (Insert landed, or clipboard fallback):
 *  count it, log its features, persist, refresh the header. The click is the
 *  signal — no post-confirmation. */
function recordSentReply(text: string, opp?: Opp, angle?: string, now: number = Date.now()): void {
  const firstToday = (replyLog.daily[dayKey(now)] || 0) === 0;
  bumpDaily(now);
  logSentReply(now, text, opp, angle);
  touchGoobi();
  // Goobi beams when you reply — but NEVER when you're past the line (honest mirror:
  // he refuses to celebrate going too fast; at ease-off he stays woozy instead).
  // The first reply of a day that extends a streak earns a bigger 'cheer' (tada).
  if (repliesLastHour() < REPLY_HARD_PER_HOUR) {
    const streak = replyStreak();
    if (firstToday && streak >= 2) goobiReact("cheer", `${streak}-day streak!`, "love that you keep showing up", 2900);
    else goobiReact("happy", "Nice reply!", "that's the good stuff", 2300);
  }
  void chrome.storage.local.set({ [CONFIG.X_REPLY_LOG_KEY]: replyLog }).catch(() => { /* best-effort */ });
  renderDock(); // update "N replies sent today" immediately
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
  const { author, text, context, getEl, oppId, angle, avatar, name } = req;
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
  const ui = { angle, avatar, name, products: candidates, productIndex };
  const root = ensurePanel();
  paintPanel(root, author, text, { loading: true, ...ui });
  const resp = await send<{ reply?: string; error?: string }>({ type: "DRAFT_REPLY", author, text, context, angle, product });
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

function paintPanel(root: ShadowRoot, author: string, text: string, opts: { loading?: boolean; note?: string; draft?: string; angle?: string; avatar?: string; name?: string; products?: ProductItem[]; productIndex?: number }) {
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
    const row = document.createElement("div"); row.className = "row";
    const copy = document.createElement("button"); copy.className = "b"; copy.textContent = "Copy";
    copy.onclick = async () => { try { await navigator.clipboard.writeText(ta.value); copy.textContent = "Copied ✓"; setTimeout(() => (copy.textContent = "Copy"), 1500); } catch { /* ignore */ } };
    const regen = document.createElement("button"); regen.className = "b"; regen.textContent = "Regenerate";
    regen.onclick = () => { if (lastDraft) void draftFor(lastDraft); };
    row.append(copy, regen);
    const foot = document.createElement("div"); foot.className = "foot"; foot.textContent = "Inserts into X's reply box — you review and post. Never auto-posts.";
    p.append(ta, insert, row, foot);
  }
  root.appendChild(p);
}

function toast(msg: string) {
  const host = document.createElement("div");
  Object.assign(host.style, { position: "fixed", bottom: "18px", left: "18px", zIndex: "2147483647" } as Partial<CSSStyleDeclaration>);
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
.d { width:452px; max-width:calc(100vw - 32px); max-height:80vh; display:flex; flex-direction:column; position:relative;
     background:#14110d; color:#f3ead9; border:.5px solid rgba(214,154,92,.18); border-radius:16px;
     font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif; box-shadow:0 16px 48px rgba(0,0,0,.55); }
.dh { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:15px 16px 10px; flex:0 0 auto; }
.dtitle { font-weight:500; font-size:18px; letter-spacing:-.2px; }
.dsub { font-weight:400; font-size:11.5px; color:#8c7d68; margin-top:3px; }
.pace { font-weight:500; white-space:nowrap; cursor:default; }
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
.df { margin:0 14px 8px; background:#221c15; border:.5px solid rgba(214,154,92,.18); border-radius:10px;
      color:#f3ead9; font:inherit; font-size:12.5px; padding:9px 12px; outline:none; flex:0 0 auto; }
.dl { overflow:auto; padding:0; }
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
.g-breathe { animation:g-breathe 3.6s ease-in-out infinite; }
.g-wobble { animation:g-wobble 1.6s ease-in-out infinite; }
.g-tada { animation:g-tada .9s ease-in-out infinite; }
@keyframes g-bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-9%)} }
@keyframes g-breathe { 0%,100%{transform:scale(1,1)} 50%{transform:scale(1.03,1.05)} }
@keyframes g-wobble { 0%,100%{transform:rotate(-5deg)} 50%{transform:rotate(5deg)} }
@keyframes g-tada { 0%,100%{transform:scale(1) rotate(0)} 20%{transform:scale(1.12) rotate(-7deg)} 40%,60%,80%{transform:scale(1.14) rotate(7deg)} 50%,70%{transform:scale(1.14) rotate(-7deg)} }
.empty { color:#8c7d68; font-size:12.5px; padding:24px 16px; text-align:center; }
.paused { padding:26px 18px 22px; text-align:center; }
.pttl { font-weight:600; font-size:14px; color:#cbb89c; }
.pcopy { font-size:12px; color:#8c7d68; line-height:1.5; margin:7px 0 14px; }
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
  document.documentElement.appendChild(dockHost);
  return dockRoot;
}

/* ---------- author reach (Twttr X-data API, best-effort enrichment) ---------- */

/** handle(lower) -> follower lookup. `followers` set once known; `pending`
 *  while a request is in flight; `failed` + `at` to back off transient misses. */
const authorReach = new Map<string, { followers?: number; following?: number; at: number; pending?: boolean; failed?: boolean }>();
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
  if (twttrUnconfigured || reachLookups >= REACH_CAP) return;
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
        if (u && u.followers >= 0) authorReach.set(key, { followers: u.followers, following: u.following, at: Date.now() });
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
function effectiveScore(o: Opp): number {
  const reach = reachFactor(o); // real follower count when known (Twttr), else the on-page likes proxy
  let buried = 1;
  if (o.likes && o.replies) {
    const ratio = o.replies / (o.likes + 1); // many replies per like = pile-on you get lost in
    buried = ratio > 1.5 ? 0.7 : ratio > 0.7 ? 0.85 : 1;
  } else if (o.replies && o.replies > 300) buried = 0.8;
  return Math.max(0, Math.min(1, o.score * freshnessFactor(o.postedAt) * reach * buried));
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
let kebabOpen = false; // the ⋮ overflow menu (Pause / Find spots / Clear all)

let goobiReactUntil = 0;                          // transient reaction window (happy/cheer)
let goobiReactMood: GoobiMood = "happy";
let goobiReactCopy: [string, string] = ["Nice reply!", "that's the good stuff"];
let goobiSearchUntil = 0;                         // "searching" window after a manual rescan
let goobiLastSeen = 0;                            // last active use (persisted)
let goobiWelcomeBack = false;                     // set at boot when you've been away a while
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
  void chrome.storage.local.set({ [CONFIG.X_GOOBI_SEEN_KEY]: goobiLastSeen }).catch(() => { /* best-effort */ });
}

/** Fire a transient Goobi reaction (happy/cheer) with its own status copy, then settle. */
function goobiReact(mood: GoobiMood, line: string, sub: string, ms: number): void {
  goobiReactUntil = Date.now() + ms; goobiReactMood = mood; goobiReactCopy = [line, sub];
  renderDock();
  setTimeout(() => { if (Date.now() >= goobiReactUntil) renderDock(); }, ms + 100);
}

/** Goobi's mood from real dock signals: he naps when nothing's going on, looks
 *  around while searching, beams when you reply, and goes woozy when you're hot. */
function goobiMood(): GoobiMood {
  const now = Date.now();
  if (now < goobiReactUntil) return goobiReactMood;               // just reacted (happy/cheer)
  if (findingSpots || now < goobiSearchUntil) return "searching"; // hunting for posts
  if (repliesLastHour() >= REPLY_HARD_PER_HOUR) return "worn";    // ease-off — honest mirror
  return opps.size > 0 ? "idle" : "sleeping";                     // posts waiting vs all quiet
}

/** Goobi's mood + status copy — shared by the dock header face, the minimized
 *  launcher, and tooltips. */
function goobiStatus(): { mood: GoobiMood; line: string; sub: string } {
  const n = opps.size;
  const mood = goobiMood();
  const reacting = Date.now() < goobiReactUntil;
  const COPY: Record<GoobiMood, [string, string]> = {
    searching: ["Sniffing out posts…", "one sec"],
    happy:     ["Nice reply!", "that's the good stuff"],
    cheer:     ["Nice!", "love that"],
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
      if (r === "followed") { followed.add(o.author); follow.textContent = "✓ Following"; toast(`Followed @${o.author}.`); }
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

function renderDock() {
  if (!enabled) return;
  const root = ensureDock();
  root.replaceChildren();
  const n = opps.size;
  if (!dockOpen) {
    const { mood, line, sub } = goobiStatus();
    const l = document.createElement("button"); l.className = "l";
    l.title = `${line} — open Goobi`;
    l.onclick = () => {
      dockOpen = true;
      if (goobiWelcomeBack) { goobiWelcomeBack = false; goobiReact("cheer", "Missed you!", "glad you're back", 4000); }
      touchGoobi();
      renderDock();
    };
    const gh = document.createElement("span"); gh.className = "lgoobi"; l.append(gh); // Goobi IS the launcher icon
    const txt = document.createElement("span"); txt.className = "ltext";
    const l1 = document.createElement("span"); l1.className = "ll1"; l1.textContent = n ? `${n} reply ${n === 1 ? "spot" : "spots"}` : "Goobi";
    txt.append(l1);
    const summary = n ? catSummary() : sub;
    if (summary) { const l2 = document.createElement("span"); l2.className = "ll2"; l2.textContent = summary; txt.append(l2); }
    l.append(txt);
    root.appendChild(l);
    mountGoobi(gh, { cell: 2 }).setMood(mood);
    return;
  }
  const d = document.createElement("div"); d.className = "d";
  const gstat = goobiStatus();
  const gh = document.createElement("div"); gh.className = "dhgoobi"; gh.title = `${gstat.line} — tap Goobi to look for posts`; gh.onclick = () => rescan();
  const h = document.createElement("div"); h.className = "dh";
  const t = document.createElement("div"); t.className = "dt";
  const ti = document.createElement("div"); ti.className = "dtitle"; ti.textContent = "Posts worth replying to";
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
  t.append(ti, sub);
  const dhl = document.createElement("div"); dhl.className = "dhl"; dhl.append(gh, t); // Goobi sits left of the title

  const acts = document.createElement("div"); acts.className = "da";
  if (!paused) {
    const re = document.createElement("button"); re.className = "scanb"; re.textContent = findingSpots ? "Searching…" : "↻ Scan again";
    re.title = "Rescan the page for new posts worth replying to";
    re.disabled = findingSpots;
    re.onclick = () => rescan();
    acts.append(re);
  }
  const kb = document.createElement("button"); kb.className = "iconb"; kb.textContent = "⋮"; kb.title = "More — pause, find spots, clear";
  kb.onclick = () => { kebabOpen = !kebabOpen; renderDock(); };
  acts.append(kb);
  const x = document.createElement("button"); x.className = "iconb"; x.textContent = "✕"; x.title = "Close";
  x.onclick = () => { kebabOpen = false; dockOpen = false; renderDock(); };
  acts.append(x);
  h.append(dhl, acts);
  d.append(h);

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
    mountGoobi(gh, { cell: 2 }).setMood("sleeping"); // resting while paused
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
  mountGoobi(gh, { cell: 2 }).setMood(gstat.mood); // Goobi lives at the top, mood-driven
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
  }
  goobiLastSeen = (await getLocal(CONFIG.X_GOOBI_SEEN_KEY)) as number || 0;
  if (goobiLastSeen && Date.now() - goobiLastSeen >= 2 * DAY_MS) goobiWelcomeBack = true; // away a while → he missed you
  void loadFavicons();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CONFIG.X_PRODUCTS_KEY]) { xProducts = (changes[CONFIG.X_PRODUCTS_KEY].newValue as ProductItem[]) || []; void loadFavicons(); renderDock(); }
    if (changes[CONFIG.X_PRODUCT_KEY]) legacyProduct = (changes[CONFIG.X_PRODUCT_KEY].newValue as string) || "";
    if (changes[CONFIG.X_DEFAULT_ANGLE_KEY]) xDefaultAngle = (changes[CONFIG.X_DEFAULT_ANGLE_KEY].newValue as string) || "";
    if (changes[CONFIG.X_DEFAULT_PRODUCT_KEY]) xDefaultProduct = (changes[CONFIG.X_DEFAULT_PRODUCT_KEY].newValue as string) || "";
    if (changes[CONFIG.X_NICHE_KEY]) xNiche = (changes[CONFIG.X_NICHE_KEY].newValue as string) || "";
    if (changes[CONFIG.X_PAUSED_KEY]) { const p = changes[CONFIG.X_PAUSED_KEY].newValue === true; if (p !== paused) { paused = p; renderDock(); if (!p) rescan(); } } // synced from the popup / another tab
    if (changes[CONFIG.X_MY_FOLLOWERS_KEY]) { myFollowers = Number(changes[CONFIG.X_MY_FOLLOWERS_KEY].newValue) || 0; renderDock(); }
    if (changes[CONFIG.TWTTR_KEY_KEY]) {
      // RapidAPI key changed — let lookups try again and drop the failed-lookup backoff.
      twttrUnconfigured = false;
      for (const [k, v] of authorReach) if (v.failed) authorReach.delete(k);
    }
  });
  renderDock();
  new MutationObserver(() => requestScan()).observe(document.body, { childList: true, subtree: true });

  // Content scripts can't intercept the page's history.pushState, so poll the URL.
  let lastUrl = location.href;
  setInterval(() => {
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
