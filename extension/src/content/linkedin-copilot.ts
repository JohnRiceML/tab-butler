import { CONFIG } from "../lib/config";
import { opportunityPresentation } from "../lib/opportunity-presentation";
import { mountGoobi, type GoobiHandle, type GoobiMood } from "../lib/goobi";
import { LI_BROKER_PROTOCOL, LI_CONSENT_VERSION, isSupportedLinkedInUrl } from "../lib/linkedin-policy";
import { normalizeCommentLog, type CommentLogEntry, type PendingCommentReview } from "../lib/linkedin-state";
import { hasCompleteLinkedInScores } from "../lib/linkedin-score-contract";
import {
  evaluateLinkedInOpportunity,
  rankLinkedInOpportunities,
  type LinkedInCommentLane,
  type LinkedInDecision,
  type LinkedInPersonEvidence,
} from "../lib/linkedin-opportunity-ranking";
import { linkedInStrategyConfigured, normalizeLinkedInStrategy, type LinkedInRelationshipRules } from "../lib/linkedin-strategy";

/**
 * Goobi for LinkedIn — a deliberately small, copy-only comment copilot.
 *
 * Privacy and interaction contract:
 * - Runs in the top frame on linkedin.com only.
 * - Reads feed post text only after LinkedIn-specific, versioned consent.
 * - Sends bounded batches to the background worker for scoring/drafting.
 * - Never opens, focuses, fills, or submits LinkedIn's comment composer.
 * - A draft can only be copied; posting and completion remain explicit user acts.
 *
 * LinkedIn changes its feed markup often. Extraction below favors semantic/data
 * attributes and canonical activity URNs, with conservative fallbacks. All of
 * Goobi's UI is isolated in closed Shadow DOM roots so LinkedIn cannot restyle it.
 */

const PLATFORM = "linkedin" as const;
// LinkedIn's person + post + contribution contract is intentionally richer than
// the X score. Smaller batches keep the structured Claude response comfortably
// inside its output budget and make one malformed post cheaper to retry.
const SCORE_BATCH_SIZE = 5;
const MAX_SCORE_CALLS = 32;
const MAX_SEEN = 800;
const SCAN_DEBOUNCE_MS = 650;
const LI_BLUE = "#0a66c2";
const LI_BLUE_DEEP = "#004182";
const LI_SKY = "#70b5f9";

type OpportunityState = "idle" | "drafting" | "ready" | "error";
type ReplyMove = "add_detail" | "counterpoint" | "concrete_example" | "narrow_question" | "substantive_support";
type ReplyRisk = "none" | "generic" | "promotional" | "context_mismatch" | "hostile";
type AuthorKind = "person" | "company" | "unknown";

const REPLY_MOVES = new Set<ReplyMove>(["add_detail", "counterpoint", "concrete_example", "narrow_question", "substantive_support"]);
const REPLY_RISKS = new Set<ReplyRisk>(["none", "generic", "promotional", "context_mismatch", "hostile"]);
const LI_DECISIONS = new Set<LinkedInDecision>(["comment", "skip", "needs_detail"]);
const LI_PERSON_EVIDENCE = new Set<LinkedInPersonEvidence>(["visible_headline", "post_stated_context", "exact_user_target", "name_only"]);
const LI_COMMENT_LANES = new Set<LinkedInCommentLane>(["mechanism", "implementation_detail", "boundary_condition", "decision_implication", "evidence_question", "supplied_example"]);

interface ScoredPost {
  i: number;
  score: number;
  reason?: string;
  category?: string;
  anchor?: string;
  replyMove?: ReplyMove;
  replyBrief?: string;
  risk?: ReplyRisk;
  decision?: LinkedInDecision;
  postFit?: number;
  personFit?: number;
  contributionFit?: number;
  postReason?: string;
  personReason?: string;
  personEvidence?: LinkedInPersonEvidence;
  commentLane?: LinkedInCommentLane;
  missingDetailPrompt?: string;
}

interface ExtractedPost {
  id: string;
  author: string;
  authorKey?: string;
  authorKind: AuthorKind;
  authorHeadline?: string;
  connectionDegree?: string;
  avatar?: string;
  text: string;
  context?: string;
  permalink?: string;
  node: HTMLElement;
}

interface QueuedPost extends ExtractedPost {
  generation: number;
  scoreAttempts: number;
}

interface Opportunity {
  id: string;
  author: string;
  authorKey?: string;
  authorKind: AuthorKind;
  authorHeadline?: string;
  connectionDegree?: string;
  avatar?: string;
  text: string;
  context?: string;
  permalink?: string;
  score: number;
  reason: string;
  category?: string;
  anchor?: string;
  replyMove?: ReplyMove;
  replyBrief?: string;
  risk: ReplyRisk;
  decision: LinkedInDecision;
  postFit: number;
  personFit: number;
  contributionFit: number;
  postReason: string;
  personReason: string;
  personEvidence: LinkedInPersonEvidence;
  commentLane: LinkedInCommentLane;
  missingDetailPrompt?: string;
  relationshipNote?: string;
  foundAt: number;
}

interface DraftState {
  id: string;
  state: OpportunityState;
  text: string;
  steer: string;
  personalDetail: string;
  error?: string;
  request: number;
}

interface UndoReceipt {
  event: Pick<CommentLogEntry, "postId" | "postedAt">;
  opportunity?: Opportunity;
  review: Pick<PendingCommentReview, "postId" | "author" | "permalink">;
  wasPending: boolean;
}

interface RailRecord {
  post: HTMLElement;
  host: HTMLElement;
  root: ShadowRoot;
  changedPosition: boolean;
  originalPosition: string;
}

const seen = new Map<string, ScoredPost>();
const opportunities = new Map<string, Opportunity>();
const livePosts = new Map<string, HTMLElement>();
const queuedIds = new Set<string>();
const inFlight = new Set<string>();
const postedIds = new Set<string>();
const pendingIds = new Set<string>();
const pendingReviews = new Map<string, PendingCommentReview>();
let recentCommentActivity: CommentLogEntry[] = [];
let relationshipRules: LinkedInRelationshipRules = normalizeLinkedInStrategy(undefined).relationship;
const rails = new Map<string, RailRecord>();
const highlightTimers = new Map<string, number>();
let queue: QueuedPost[] = [];

let enabled = false;
let consented = false;
let hasKey = false;
let focusReady = false;
let paused = false;
let active = false;
let invalidated = false;
let brokerCompatible = false;
let scoreCalls = 0;
let generation = 1;
let requestSequence = 0;
let dockExpanded = true;
let selectedId = "";
let undoReceipt: UndoReceipt | null = null;
let notice = "";
let scoringError = "";
let visibleRootCount = 0;
let extractablePostCount = 0;
let scoredPostCount = 0;
let skippedPostCount = 0;
let needsDetailPostCount = 0;
let policyBlockedPostCount = 0;
let noticeTimer: number | undefined;
let draft: DraftState | null = null;
let liGoobiHandle: GoobiHandle | null = null;
let confirmedReactionUntil = 0;
let confirmedReactionTimer: number | undefined;
const reducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");

let dockHost: HTMLElement | null = null;
let dockRoot: ShadowRoot | null = null;
let bodyObserver: MutationObserver | null = null;
let scanTimer: number | undefined;
let flushTimer: number | undefined;
let flushInProgress = false;
let urlPoll: number | undefined;
let lastUrl = location.href;
let gateEpoch = 0;

function contextOK(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function isContextInvalidated(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message ?? String(error ?? "");
  return /extension context|context invalidated/i.test(message);
}

function getLocal(key: string): Promise<unknown> {
  return new Promise((resolve) => {
    if (invalidated || !contextOK()) {
      resolve(undefined);
      return;
    }
    try {
      chrome.storage.local.get(key, (value) => {
        if (chrome.runtime.lastError) resolve(undefined);
        else resolve(value[key]);
      });
    } catch (error) {
      if (isContextInvalidated(error)) teardown();
      resolve(undefined);
    }
  });
}

function getLocalMany(keys: readonly string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (invalidated || !contextOK()) {
      resolve({});
      return;
    }
    try {
      chrome.storage.local.get([...keys], (value) => {
        if (chrome.runtime.lastError) resolve({});
        else resolve(value);
      });
    } catch (error) {
      if (isContextInvalidated(error)) teardown();
      resolve({});
    }
  });
}

function setLocal(value: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    if (invalidated || !contextOK()) {
      resolve(false);
      return;
    }
    try {
      chrome.storage.local.set(value, () => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(true);
      });
    } catch (error) {
      if (isContextInvalidated(error)) teardown();
      resolve(false);
    }
  });
}

function send<T>(message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => {
    if (invalidated || !contextOK()) {
      resolve(undefined);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          if (isContextInvalidated(chrome.runtime.lastError)) teardown();
          resolve(undefined);
        } else {
          resolve(response as T);
        }
      });
    } catch (error) {
      if (isContextInvalidated(error)) teardown();
      resolve(undefined);
    }
  });
}

function cleanInline(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function clampScore(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function validReplyMove(value: unknown): ReplyMove | undefined {
  return typeof value === "string" && REPLY_MOVES.has(value as ReplyMove) ? value as ReplyMove : undefined;
}

function validReplyRisk(value: unknown): ReplyRisk | undefined {
  return typeof value === "string" && REPLY_RISKS.has(value as ReplyRisk) ? value as ReplyRisk : undefined;
}

function validUnitScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function validDecision(value: unknown): LinkedInDecision | undefined {
  return typeof value === "string" && LI_DECISIONS.has(value as LinkedInDecision) ? value as LinkedInDecision : undefined;
}

function validPersonEvidence(value: unknown): LinkedInPersonEvidence | undefined {
  return typeof value === "string" && LI_PERSON_EVIDENCE.has(value as LinkedInPersonEvidence) ? value as LinkedInPersonEvidence : undefined;
}

function validCommentLane(value: unknown): LinkedInCommentLane | undefined {
  return typeof value === "string" && LI_COMMENT_LANES.has(value as LinkedInCommentLane) ? value as LinkedInCommentLane : undefined;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}

function normalizePermalink(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw, location.origin);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return undefined;
    if (!/(\/feed\/update\/|\/posts\/)/i.test(url.pathname)) return undefined;
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function activityIdentity(value: string): { id: string; activity: string } | null {
  const decoded = (() => {
    try { return decodeURIComponent(value); } catch { return value; }
  })();
  const urn = decoded.match(/urn:li:(activity|ugcPost|share):(\d{6,})/i);
  if (urn) return { id: `${urn[1].toLowerCase()}:${urn[2]}`, activity: urn[2] };
  const slug = decoded.match(/(?:activity[-:]|activity%3A)(\d{6,})/i);
  return slug ? { id: `activity:${slug[1]}`, activity: slug[1] } : null;
}

function identityFor(post: HTMLElement, author: string, text: string): { id: string; permalink?: string } {
  const ownAttributes = [
    post.getAttribute("data-urn"),
    post.getAttribute("data-id"),
    post.getAttribute("data-entity-urn"),
    post.getAttribute("data-update-urn"),
  ].filter((value): value is string => Boolean(value));

  const descendant = post.querySelector<HTMLElement>(
    "[data-urn*='urn:li:activity:'],[data-urn*='urn:li:ugcPost:'],[data-urn*='urn:li:share:'],[data-id*='urn:li:activity:'],[data-id*='urn:li:ugcPost:'],[data-id*='urn:li:share:'],[data-entity-urn*='urn:li:'],[data-update-urn*='urn:li:']",
  );
  if (descendant) {
    for (const name of ["data-urn", "data-id", "data-entity-urn", "data-update-urn"]) {
      const value = descendant.getAttribute(name);
      if (value) ownAttributes.push(value);
    }
  }

  const links = Array.from(post.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const canonical = links.find((anchor) => /\/feed\/update\/urn:li:|\/posts\/[^/?#]+/i.test(anchor.getAttribute("href") ?? ""));
  const permalink = normalizePermalink(canonical?.getAttribute("href"));
  const candidates = [...ownAttributes, canonical?.getAttribute("href") ?? "", permalink ?? ""];
  for (const candidate of candidates) {
    const identity = activityIdentity(candidate);
    if (identity) {
      return {
        id: identity.id,
        permalink: permalink ?? `https://www.linkedin.com/feed/update/urn:li:activity:${identity.activity}/`,
      };
    }
  }

  // LinkedIn occasionally withholds the URN until an update is interacted with.
  // A deterministic author+body key remains stable across virtualization without
  // leaking DOM order into identity; the canonical URL is still used when present.
  return { id: `content:${hash(`${author.toLowerCase()}\n${text.slice(0, 360)}`)}`, permalink };
}

const POST_SELECTORS = [
  "main [data-testid='mainFeed'] [role='listitem']",
  "main [data-testid='main-feed-activity-card']",
  "main [data-test-id='main-feed-activity-card']",
  "main div.feed-shared-update-v2",
  "main [data-view-name='feed-full-update']",
  "main [data-urn*='urn:li:activity:']",
  "main [data-urn*='urn:li:ugcPost:']",
  "main [data-urn*='urn:li:share:']",
  "main [data-id*='urn:li:activity:']",
  "main [data-id*='urn:li:ugcPost:']",
  "main [data-id*='urn:li:share:']",
  "main [data-entity-urn*='urn:li:']",
  "main [data-update-urn*='urn:li:']",
  "main [role='listitem']",
  "main article",
];

function postRoots(): HTMLElement[] {
  const candidates = new Set<HTMLElement>();
  for (const selector of POST_SELECTORS) {
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      // Data URNs also appear on inner tracking wrappers. Lift those matches to
      // the actual feed card so the rail outlines the whole, exact post.
      const card = element.closest<HTMLElement>(
        "[data-testid='mainFeed'] [role='listitem'],[data-testid='main-feed-activity-card'],[data-test-id='main-feed-activity-card'],.feed-shared-update-v2,[data-view-name='feed-full-update'],article",
      );
      candidates.add(card ?? element);
    });
  }

  const ordered = [...candidates].filter((element) => {
    if (element.closest("goobi-li-rail,goobi-li-dock")) return false;
    if (!element.closest("main")) return false;
    const hasBody = Boolean(element.querySelector(
      "[data-testid='expandable-text-box'],[data-test-id='expandable-text-box'],.update-components-text,.feed-shared-text,[data-view-name='feed-commentary'],[data-testid='main-feed-activity-card__commentary'],[data-test-id='main-feed-activity-card__commentary']",
    ));
    const hasIdentity = Boolean(
      element.matches("[data-urn*='urn:li:activity:'],[data-urn*='urn:li:ugcPost:'],[data-urn*='urn:li:share:'],[data-id*='urn:li:activity:'],[data-id*='urn:li:ugcPost:'],[data-id*='urn:li:share:'],[data-entity-urn*='urn:li:'],[data-update-urn*='urn:li:']") ||
      element.querySelector("[data-urn*='urn:li:'],[data-id*='urn:li:'],[data-entity-urn*='urn:li:'],[data-update-urn*='urn:li:'],a[href*='/feed/update/urn:li:activity:'],a[href*='/posts/']"),
    );
    return hasBody || hasIdentity;
  });

  // Broad fallbacks can return both a wrapper and its inner activity. Keep the
  // most LinkedIn-specific outer card and one node per eventual activity id.
  return ordered.filter((element, index) => !ordered.some((other, otherIndex) => {
    if (index === otherIndex || !other.contains(element)) return false;
    return other.matches("[role='listitem'],.feed-shared-update-v2,[data-view-name='feed-full-update']");
  }));
}

function promoted(post: HTMLElement): boolean {
  if (post.matches("[data-promoted='true'],[data-sponsored='true']")) return true;
  if (post.querySelector("[data-test-relevance-ads],[data-ad-banner],[aria-label*='Promoted']")) return true;
  const labels = Array.from(post.querySelectorAll<HTMLElement>(
    ".update-components-actor__sub-description,.feed-shared-actor__sub-description,[data-view-name='feed-actor-metadata'],span,p",
  ));
  return labels.some((label) => /^(promoted|sponsored|advertisement)(\s*[·•].*)?$/i.test(cleanInline(label.textContent ?? "", 80)));
}

function profilePath(anchor: HTMLAnchorElement | null): string {
  if (!anchor?.href) return "";
  try {
    const url = new URL(anchor.href, location.origin);
    return url.hostname === "www.linkedin.com" && url.pathname.startsWith("/in/")
      ? url.pathname.replace(/\/+$/, "").toLowerCase()
      : "";
  } catch {
    return "";
  }
}

function actorProfileAnchor(post: HTMLElement): HTMLAnchorElement | null {
  const selectors = [
    ".update-components-actor__container a[href*='/in/'],.update-components-actor__container a[href*='/company/']",
    ".feed-shared-actor a[href*='/in/'],.feed-shared-actor a[href*='/company/']",
    "[data-view-name='feed-actor'] a[href*='/in/'],[data-view-name='feed-actor'] a[href*='/company/']",
    "[data-test-id='main-feed-activity-card__actor'] a[href*='/in/'],[data-test-id='main-feed-activity-card__actor'] a[href*='/company/']",
    "a[href*='/in/'],a[href*='/company/']",
  ];
  for (const selector of selectors) {
    const anchor = Array.from(post.querySelectorAll<HTMLAnchorElement>(selector))
      .find((candidate) => !candidate.closest(RESHARED_CONTENT_SELECTOR));
    if (anchor) return anchor;
  }
  return null;
}

function canonicalAuthorPath(anchor: HTMLAnchorElement | null): string | undefined {
  if (!anchor?.href) return undefined;
  try {
    const url = new URL(anchor.href, location.origin);
    if (url.hostname !== "www.linkedin.com") return undefined;
    const match = url.pathname.match(/^\/(in|company)\/[^/?#]+/i);
    return match ? match[0].replace(/\/+$/, "").toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function authorHeadlineFrom(post: HTMLElement): string | undefined {
  const selectors = [
    ".update-components-actor__description",
    ".feed-shared-actor__description",
    "[data-view-name='feed-actor-description']",
    "[data-test-id='main-feed-activity-card__actor-description']",
  ];
  for (const selector of selectors) {
    const element = Array.from(post.querySelectorAll<HTMLElement>(selector))
      .find((candidate) => !candidate.closest(RESHARED_CONTENT_SELECTOR));
    const text = cleanInline(element?.innerText || element?.textContent || "", 220);
    if (text) return text;
  }
  // LinkedIn's newer feed uses generated class names and places the visible
  // headline in the immediate parent of the actor profile link. Read only that
  // compact actor block so post copy can never be mistaken for a headline.
  const actorBlock = actorProfileAnchor(post)?.parentElement;
  if (!actorBlock || actorBlock.querySelector("[data-testid='expandable-text-box'],[data-test-id='expandable-text-box']")) return undefined;
  const author = authorFrom(post).toLocaleLowerCase();
  const lines = (actorBlock.innerText || actorBlock.textContent || "")
    .split(/\n+/)
    .map((line) => cleanInline(line, 220))
    .filter(Boolean);
  return lines.find((line) => {
    const lower = line.toLocaleLowerCase();
    return lower !== author &&
      !/^(?:feed post|visit my website|follow|following|connect|message)$/i.test(line) &&
      !/^(?:premium profile\s*)?(?:[·•]\s*)?(?:1st|2nd|3rd)$/i.test(line) &&
      !/^(?:[·•]\s*)?\d+\s*(?:m|h|d|w|mo|y)(?:\s*[·•])?$/i.test(line);
  });
  return undefined;
}

function connectionDegreeFrom(post: HTMLElement): string | undefined {
  const selectors = [
    ".update-components-actor__container",
    ".feed-shared-actor",
    "[data-view-name='feed-actor']",
    "[data-test-id='main-feed-activity-card__actor']",
  ];
  for (const selector of selectors) {
    const element = Array.from(post.querySelectorAll<HTMLElement>(selector))
      .find((candidate) => !candidate.closest(RESHARED_CONTENT_SELECTOR));
    const text = cleanInline(element?.innerText || element?.textContent || "", 500);
    const degree = text.match(/(?:^|[\s·•])(1st|2nd|3rd)(?=$|[\s·•])/i)?.[1]?.toLowerCase();
    if (degree) return degree;
    if (/(?:^|[\s·•])following(?=$|[\s·•])/i.test(text)) return "following";
  }
  const actorBlock = actorProfileAnchor(post)?.parentElement;
  const actorText = cleanInline(actorBlock?.innerText || actorBlock?.textContent || "", 500);
  const degree = actorText.match(/(?:^|[\s·•])(1st|2nd|3rd)(?=$|[\s·•])/i)?.[1]?.toLowerCase();
  if (degree) return degree;
  if (/(?:^|[\s·•])following(?=$|[\s·•])/i.test(actorText)) return "following";
  return undefined;
}

function isSelfPost(post: HTMLElement): boolean {
  const self = profilePath(document.querySelector<HTMLAnchorElement>("main [aria-label='Sidebar'] a[href*='/in/']"));
  if (!self) return false;
  const actor = profilePath(actorProfileAnchor(post));
  return Boolean(actor && actor === self);
}

function authorFrom(post: HTMLElement): string {
  const menuLabel = post.querySelector<HTMLElement>("[aria-label^='Open control menu for post by ']")?.getAttribute("aria-label") ?? "";
  const menuAuthor = cleanInline(menuLabel.replace(/^Open control menu for post by\s+/i, ""), 120);
  if (menuAuthor) return menuAuthor;
  const selectors = [
    ".update-components-actor__name",
    ".feed-shared-actor__name",
    "[data-view-name='feed-actor-name']",
    "[data-test-id='main-feed-activity-card__actor-name']",
    "a[href*='/in/'] span[aria-hidden='true']",
    "a[href*='/company/'] span[aria-hidden='true']",
  ];
  for (const selector of selectors) {
    const element = post.querySelector<HTMLElement>(selector);
    const author = cleanInline(element?.innerText || element?.textContent || "", 120)
      .replace(/^View\s+/i, "")
      .replace(/['’]s profile$/i, "")
      .replace(/\s*[•·]\s*(?:1st|2nd|3rd).*$/i, "")
      .replace(/\s+(?:Premium Profile|Verified)$/i, "")
      .trim();
    if (author) return author;
  }
  for (const anchor of post.querySelectorAll<HTMLAnchorElement>("a[href*='/in/'],a[href*='/company/']")) {
    const author = cleanInline(anchor.innerText || anchor.textContent || "", 120)
      .replace(/^View\s+/i, "")
      .replace(/['’]s profile$/i, "")
      .replace(/\s*[•·]\s*(?:1st|2nd|3rd).*$/i, "")
      .replace(/\s+(?:Premium Profile|Verified)$/i, "")
      .trim();
    if (author) return author;
  }
  return "LinkedIn member";
}

const RESHARED_CONTENT_SELECTOR = ".update-components-mini-update-v2,.feed-shared-mini-update-v2,[data-view-name='feed-reshared-content']";
const ACTOR_IMAGE_SELECTORS = [
  "[data-view-name='feed-actor-image'] img",
  "img[data-testid='main-feed-activity-card__actor-image']",
  "[data-testid='main-feed-activity-card__actor-image'] img",
  "img[data-test-id='main-feed-activity-card__actor-image']",
  "[data-test-id='main-feed-activity-card__actor-image'] img",
  ".update-components-actor__avatar img",
  ".update-components-actor__image img",
  "img.update-components-actor__avatar-image",
  ".feed-shared-actor__avatar img",
  ".feed-shared-actor__image img",
  "img.feed-shared-actor__avatar-image",
];

function avatarNameKey(value: string): string {
  return value.normalize("NFKC").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

function validAvatarUrl(raw: string | null | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || value.length > 4_096) return undefined;
  try {
    const url = new URL(value, location.origin);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return undefined;
    if (!(host === "linkedin.com" || host.endsWith(".linkedin.com") || host === "licdn.com" || host.endsWith(".licdn.com"))) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function avatarUrlFromImage(image: HTMLImageElement): string | undefined {
  const srcset = image.getAttribute("srcset")
    ?.split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean)
    .reverse() ?? [];
  const candidates = [
    image.currentSrc,
    image.getAttribute("src"),
    ...srcset,
    image.getAttribute("data-delayed-url"),
    image.getAttribute("data-src"),
  ];
  for (const candidate of candidates) {
    const valid = validAvatarUrl(candidate);
    if (valid) return valid;
  }
  return undefined;
}

function avatarFrom(post: HTMLElement, author: string): string | undefined {
  const allowed = (image: HTMLImageElement): boolean => !image.closest(RESHARED_CONTENT_SELECTOR);
  for (const selector of ACTOR_IMAGE_SELECTORS) {
    const image = Array.from(post.querySelectorAll<HTMLImageElement>(selector)).find(allowed);
    const url = image ? avatarUrlFromImage(image) : undefined;
    if (url) return url;
  }
  const profileImages = Array.from(post.querySelectorAll<HTMLImageElement>("a[href*='/in/'] img,a[href*='/company/'] img"))
    .filter(allowed);
  const authorKey = avatarNameKey(author);
  const exact = profileImages.find((image) => {
    const label = cleanInline(image.alt, 180);
    const named = label
      .replace(/^View company:\s*/i, "")
      .replace(/^View\s+/i, "")
      .replace(/['’]s profile$/i, "")
      .trim();
    return named && avatarNameKey(named) === authorKey;
  });
  if (exact) {
    const url = avatarUrlFromImage(exact);
    if (url) return url;
  }
  const fallback = profileImages[0];
  return fallback ? avatarUrlFromImage(fallback) : undefined;
}

function postText(post: HTMLElement): string {
  const selectors = [
    "[data-testid='expandable-text-box']",
    "[data-test-id='expandable-text-box']",
    ".update-components-text",
    "[data-test-id='main-feed-activity-card__commentary']",
    "[data-view-name='feed-commentary']",
    ".feed-shared-text",
    ".feed-shared-update-v2__description",
  ];
  for (const selector of selectors) {
    const elements = Array.from(post.querySelectorAll<HTMLElement>(selector));
    const outer = elements.find((element) => !element.closest(
      ".update-components-mini-update-v2,.feed-shared-mini-update-v2,[data-view-name='feed-reshared-content']",
    )) ?? elements[0];
    const text = cleanInline(outer?.innerText || outer?.textContent || "", 1_200);
    if (text) return text;
  }
  return "";
}

function resharedContext(post: HTMLElement): string | undefined {
  const context = post.querySelector<HTMLElement>(
    ".update-components-mini-update-v2 .update-components-text,.feed-shared-mini-update-v2 .feed-shared-text,[data-view-name='feed-reshared-content']",
  );
  const text = cleanInline(context?.innerText || context?.textContent || "", 500);
  return text || undefined;
}

function extractPost(node: HTMLElement): ExtractedPost | null {
  if (promoted(node) || isSelfPost(node)) return null;
  const text = postText(node);
  if (!text) return null;
  const author = authorFrom(node);
  const actorAnchor = actorProfileAnchor(node);
  const authorKey = canonicalAuthorPath(actorAnchor);
  const authorKind: AuthorKind = authorKey?.startsWith("/in/")
    ? "person"
    : authorKey?.startsWith("/company/")
      ? "company"
      : "unknown";
  const identity = identityFor(node, author, text);
  return {
    id: identity.id,
    author,
    authorKey,
    authorKind,
    authorHeadline: authorHeadlineFrom(node),
    connectionDegree: connectionDegreeFrom(node),
    avatar: avatarFrom(node, author),
    text: text.slice(0, 1_200),
    context: resharedContext(node),
    permalink: identity.permalink,
    node,
  };
}

function postMatchesSnapshot(post: ExtractedPost): boolean {
  // LinkedIn virtualizes feed cards aggressively. The bounded immutable
  // snapshot was captured while visible, so a disconnected node is still safe
  // to classify. Only reject a connected node that has been recycled in place.
  if (!post.node.isConnected) return true;
  const current = extractPost(post.node);
  return Boolean(
    current &&
    current.id === post.id &&
    current.author === post.author &&
    (current.authorKey ?? "") === (post.authorKey ?? "") &&
    current.authorKind === post.authorKind &&
    (current.authorHeadline ?? "") === (post.authorHeadline ?? "") &&
    (current.connectionDegree ?? "") === (post.connectionDegree ?? "") &&
    current.text === post.text &&
    (current.context ?? "") === (post.context ?? ""),
  );
}

function pruneLiveReferences(): void {
  for (const [id, post] of livePosts) if (!post.isConnected) livePosts.delete(id);
  for (const [id, rail] of rails) if (!rail.post.isConnected || !rail.host.isConnected) removeRail(id);
  if (seen.size <= MAX_SEEN) return;
  const keep = new Set([...opportunities.keys(), ...postedIds]);
  for (const id of seen.keys()) {
    if (!keep.has(id)) seen.delete(id);
    if (seen.size <= Math.floor(MAX_SEEN * 0.75)) break;
  }
}

function forgetRecycledNode(node: HTMLElement, currentId: string): void {
  const staleIds = [...livePosts.entries()]
    .filter(([id, priorNode]) => priorNode === node && id !== currentId)
    .map(([id]) => id);
  if (!staleIds.length) return;
  const stale = new Set(staleIds);
  queue = queue.filter((post) => !stale.has(post.id));
  for (const id of staleIds) {
    const savedOpportunity = opportunities.has(id);
    livePosts.delete(id);
    if (!savedOpportunity) seen.delete(id);
    queuedIds.delete(id);
    inFlight.delete(id);
    removeRail(id);
  }
}

function resetScanReceipt(): void {
  visibleRootCount = 0;
  extractablePostCount = 0;
  scoredPostCount = 0;
  skippedPostCount = 0;
  needsDetailPostCount = 0;
  policyBlockedPostCount = 0;
}

function requestScan(): void {
  if (!active || paused || invalidated || !isSupportedLinkedInUrl(location.href)) return;
  if (scanTimer !== undefined) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    scan();
  }, SCAN_DEBOUNCE_MS);
}

function scan(): void {
  if (!active || paused || invalidated || !contextOK() || !isSupportedLinkedInUrl(location.href)) {
    if (!contextOK()) teardown();
    return;
  }
  pruneLiveReferences();
  const found = postRoots();
  visibleRootCount = found.length;
  let extractedCount = 0;
  let avatarsChanged = false;
  for (const root of found) {
    const post = extractPost(root);
    if (!post) continue;
    extractedCount += 1;
    forgetRecycledNode(root, post.id);
    livePosts.set(post.id, root);
    if (postedIds.has(post.id)) {
      removeRail(post.id);
      opportunities.delete(post.id);
      continue;
    }
    const existing = opportunities.get(post.id);
    if (existing) {
      if (post.avatar && post.avatar !== existing.avatar) {
        existing.avatar = post.avatar;
        avatarsChanged = true;
      }
      continue;
    }
    if (scoringError || seen.has(post.id) || queuedIds.has(post.id) || inFlight.has(post.id)) continue;
    queuedIds.add(post.id);
    queue.push({ ...post, generation, scoreAttempts: 0 });
  }
  extractablePostCount = extractedCount;
  syncOpportunityRails();
  if (avatarsChanged || !inFlight.size) renderDock();
  scheduleFlush();
}

function scheduleFlush(): void {
  if (!active || paused || invalidated || scoringError || !queue.length) return;
  if (flushTimer !== undefined || flushInProgress) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    void flushScores();
  }, 250);
}

interface ScoringFailureCopy {
  detail: string;
  notice: string;
}

/** Convert broker errors into safe, actionable UI copy without exposing keys or payloads. */
function scoringFailureCopy(error?: string): ScoringFailureCopy {
  if (error?.startsWith("jev-")) return {
    detail: /key-required|consent-required/.test(error) ? "Jev analysis needs a key and its data-use opt-in." : "Jev could not complete this analysis batch.",
    notice: "Use Retry scan, or switch analysis back to Claude in Goobi settings. No automatic fallback was made.",
  };
  if (!error) return {
    detail: "Goobi could not reach the background worker.",
    notice: "Refresh LinkedIn, then use Retry scan.",
  };
  if (error === "bad-output") return {
    detail: "Claude returned an incomplete scoring batch.",
    notice: "Use Retry scan. Goobi now sends smaller groups of posts.",
  };
  if (error === "bad-linkedin-score-output") return {
    detail: "Claude returned an incomplete LinkedIn scoring batch.",
    notice: "Goobi will retry each post once. Use Retry scan if this continues.",
  };
  if (error === "linkedin-broker-timeout") return {
    detail: "Claude took too long to finish this scoring batch.",
    notice: "Use Retry scan in a moment. Your saved opportunities are safe.",
  };
  if (error === "anthropic-busy" || error === "anthropic-queue-timeout") return {
    detail: "Goobi's shared AI queue is busy.",
    notice: "Wait for current drafts to finish, then use Retry scan.",
  };
  if (error === "anthropic-timeout") return {
    detail: "Claude took too long. Goobi stopped the request.",
    notice: "Use Retry scan in a moment. Your saved opportunities are safe.",
  };
  if (error === "anthropic-cancelled") return {
    detail: "This scan was stopped after a settings change.",
    notice: "Use Retry scan to continue with your current settings.",
  };
  if (error === "anthropic-output-truncated" || error === "anthropic-output-refused") return {
    detail: "Claude did not return a complete usable assessment.",
    notice: "Use Retry scan when you are ready. Your saved opportunities are safe.",
  };
  if (error === "no-focus") return {
    detail: "Your LinkedIn comment thesis is not set yet.",
    notice: "Open the Goobi side panel and finish LinkedIn setup.",
  };
  if (error === "linkedin-disabled") return {
    detail: "LinkedIn scoring is not enabled for the current consent version.",
    notice: "Open the Goobi side panel and review LinkedIn setup.",
  };
  if (error === "unsupported-linkedin-sender") return {
    detail: "This LinkedIn page is not a supported scoring surface.",
    notice: "Open the main LinkedIn feed or a public post, then rescan.",
  };
  if (error === "invalid-linkedin-payload") return {
    detail: "A visible post could not be prepared safely for scoring.",
    notice: "Refresh LinkedIn, then use Retry scan.",
  };
  if (/^anthropic 401\b/.test(error)) return {
    detail: "Anthropic rejected the saved API key.",
    notice: "Update the Anthropic key in the Goobi side panel.",
  };
  if (/^anthropic 400 billing\b/.test(error)) return {
    detail: "The Anthropic account has no usable API credits.",
    notice: "Add Anthropic API credits, then use Retry scan.",
  };
  if (/^anthropic 400 spend-limit\b/.test(error)) return {
    detail: "The Anthropic workspace has reached a usage limit.",
    notice: "Raise the workspace spend limit or use a key from the funded workspace, then use Retry scan.",
  };
  if (/^anthropic 400 model-access\b/.test(error)) return {
    detail: "This Anthropic account cannot use the LinkedIn scoring model.",
    notice: "Goobi tried both supported Sonnet models. Check model access, then use Retry scan.",
  };
  if (/^anthropic 400 request-too-large\b/.test(error)) return {
    detail: "Anthropic rejected this scoring batch because its input was too large.",
    notice: "Refresh LinkedIn, then use Retry scan with the smaller batch size.",
  };
  if (/^anthropic 400 (?:thinking-parameter|effort-parameter|max-tokens|sampling-parameter|system-parameter|messages-parameter)\b/.test(error)) return {
    detail: "Anthropic rejected a scoring model setting.",
    notice: "Reload the latest Goobi build, then use Retry scan.",
  };
  if (/^anthropic 400\b/.test(error)) return {
    detail: "Anthropic rejected the scoring request.",
    notice: "Goobi tried a simpler compatible request. Reload the latest build, then use Retry scan.",
  };
  if (/^anthropic 403\b/.test(error)) return {
    detail: "Anthropic denied this model request.",
    notice: "Check Anthropic account access, then use Retry scan.",
  };
  if (/^anthropic 429\b/.test(error)) return {
    detail: "Anthropic is rate limiting scoring right now.",
    notice: "Wait a moment, then use Retry scan. Your saved opportunities are safe.",
  };
  if (/^anthropic 529\b/.test(error) || /overloaded\b/.test(error)) return {
    detail: "Anthropic is temporarily overloaded.",
    notice: "Wait a moment, then use Retry scan. Your saved opportunities are safe.",
  };
  return {
    detail: "LinkedIn scoring stopped after an unexpected broker error.",
    notice: "Use Retry scan. Your saved opportunities are safe.",
  };
}

async function flushScores(): Promise<void> {
  if (flushInProgress) return;
  flushInProgress = true;
  try {
    await flushScoresOnce();
  } finally {
    flushInProgress = false;
    renderDock();
    if (queue.length && active && !paused && !invalidated) scheduleFlush();
  }
}

function requeueIncompleteScoreBatch(batch: readonly QueuedPost[]): number {
  const retryable = batch
    .filter((post) => post.scoreAttempts < 1 && !seen.has(post.id) && !postedIds.has(post.id))
    .map((post) => ({ ...post, generation, scoreAttempts: post.scoreAttempts + 1 }));
  for (const post of retryable.reverse()) {
    if (queuedIds.has(post.id)) continue;
    queuedIds.add(post.id);
    queue.unshift(post);
  }
  return retryable.length;
}

async function flushScoresOnce(): Promise<void> {
  if (!active || paused || invalidated || scoringError || !contextOK() || !isSupportedLinkedInUrl(location.href)) return;
  if (scoreCalls >= MAX_SCORE_CALLS) {
    queue = [];
    queuedIds.clear();
    showNotice("Session scan limit reached. Rescan when you want another pass.");
    return;
  }

  const callGeneration = generation;
  const callUrl = location.href;
  const requestedBatchSize = queue[0]?.scoreAttempts ? 1 : SCORE_BATCH_SIZE;
  const batch = queue.splice(0, requestedBatchSize).filter((post) => {
    queuedIds.delete(post.id);
    return post.generation === callGeneration && postMatchesSnapshot(post) && !seen.has(post.id) && !postedIds.has(post.id);
  });
  if (!batch.length) {
    if (queue.length) scheduleFlush();
    return;
  }

  scoreCalls += 1;
  batch.forEach((post) => inFlight.add(post.id));
  renderDock();
  const response = await send<{ scores?: ScoredPost[]; error?: string }>({
    type: "LI_SCORE_POSTS",
    posts: batch.map((post, index) => ({
      i: index,
      author: post.author,
      text: post.text,
      context: post.context,
      authorHeadline: post.authorHeadline,
      authorKind: post.authorKind,
      connectionDegree: post.connectionDegree,
      meta: "Post visible in the user's LinkedIn feed. Evaluate whether a substantive comment would add value.",
    })),
  });
  batch.forEach((post) => inFlight.delete(post.id));

  if (invalidated || !active || paused || callGeneration !== generation || callUrl !== location.href) return;
  if (response?.error === "no-key") {
    hasKey = false;
    deactivateScanning(false);
    renderDock();
    showNotice("Add your Anthropic key in the Goobi side panel.");
    return;
  }
  if (!response || response.error) {
    if (response?.error === "bad-linkedin-score-output") {
      const retryCount = requeueIncompleteScoreBatch(batch);
      if (retryCount) {
        scoringError = "";
        showNotice("Claude returned an incomplete batch. Goobi is retrying each post once.");
        renderDock();
        return;
      }
    }
    const failure = scoringFailureCopy(response?.error);
    scoringError = failure.detail;
    retainFailedScoreBatch(batch);
    // This failure is handled in-product. Keep its bounded code available for
    // diagnostics without polluting chrome://extensions with a false crash.
    if (response?.error) console.debug("[goobi linkedin] scoring broker error", response.error);
    showNotice(failure.notice);
    renderDock();
    return;
  }
  const completeScores = Array.isArray(response.scores) && hasCompleteLinkedInScores(response.scores, batch.length);
  if (!completeScores) {
    const retryCount = requeueIncompleteScoreBatch(batch);
    if (retryCount) {
      scoringError = "";
      showNotice("Claude returned an incomplete batch. Goobi is retrying each post once.");
    } else {
      const failure = scoringFailureCopy("bad-linkedin-score-output");
      scoringError = failure.detail;
      retainFailedScoreBatch(batch);
      showNotice(failure.notice);
    }
    renderDock();
    return;
  }
  scoringError = "";

  let changed = false;
  for (const score of response.scores ?? []) {
    const post = batch[Number(score.i)];
    if (!post || !postMatchesSnapshot(post)) continue;
    const normalized: ScoredPost = {
      i: Number(score.i),
      score: clampScore(score.score),
      reason: cleanInline(score.reason, 120),
      category: cleanInline(score.category, 40) || undefined,
      anchor: cleanInline(score.anchor, 220) || undefined,
      replyMove: validReplyMove(score.replyMove),
      replyBrief: cleanInline(score.replyBrief, 300) || undefined,
      risk: validReplyRisk(score.risk),
      decision: validDecision(score.decision),
      postFit: validUnitScore(score.postFit),
      personFit: validUnitScore(score.personFit),
      contributionFit: validUnitScore(score.contributionFit),
      postReason: cleanInline(score.postReason, 160) || undefined,
      personReason: cleanInline(score.personReason, 160) || undefined,
      personEvidence: validPersonEvidence(score.personEvidence),
      commentLane: validCommentLane(score.commentLane),
      missingDetailPrompt: cleanInline(score.missingDetailPrompt, 180) || undefined,
    };
    seen.set(post.id, normalized);
    scoredPostCount += 1;
    const eligibility = evaluateLinkedInOpportunity({ ...normalized, text: post.text, context: post.context });
    if (!eligibility.eligible || postedIds.has(post.id)) {
      if (normalized.decision === "skip") skippedPostCount += 1;
      else policyBlockedPostCount += 1;
      continue;
    }
    if (normalized.decision === "needs_detail") needsDetailPostCount += 1;
    const opportunity: Opportunity = {
      id: post.id,
      author: post.author,
      authorKey: post.authorKey,
      authorKind: post.authorKind,
      authorHeadline: post.authorHeadline,
      connectionDegree: post.connectionDegree,
      avatar: extractPost(post.node)?.avatar ?? post.avatar,
      text: post.text,
      context: post.context,
      permalink: post.permalink,
      score: eligibility.priority,
      reason: normalized.postReason!,
      category: normalized.category,
      anchor: normalized.anchor!,
      replyMove: normalized.replyMove,
      replyBrief: normalized.replyBrief!,
      risk: normalized.risk!,
      decision: normalized.decision!,
      postFit: normalized.postFit!,
      personFit: normalized.personFit!,
      contributionFit: normalized.contributionFit!,
      postReason: normalized.postReason!,
      personReason: normalized.personReason!,
      personEvidence: normalized.personEvidence!,
      commentLane: normalized.commentLane!,
      missingDetailPrompt: normalized.missingDetailPrompt,
      foundAt: Date.now(),
    };
    opportunities.set(post.id, opportunity);
    changed = true;
  }

  syncOpportunityRails();

  if (changed) {
    if (!selectedId || !opportunities.has(selectedId)) selectedId = sortedOpportunities()[0]?.id ?? "";
  }
  renderDock();
}

const RAIL_CSS = `
  :host { all: initial; position: absolute; inset: 0; z-index: 4; pointer-events: none; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .edge { position:absolute; top:16px; right:8px; bottom:16px; width:3px; border-radius:99px; background:var(--opportunity-accent,#0a66c2); opacity:.65; transition:opacity .18s ease,width .18s ease; }
  .tag { pointer-events:auto; position:absolute; top:18px; right:14px; display:flex; align-items:center; gap:7px; min-height:30px; padding:5px 10px 5px 6px; border:1px solid rgba(10,102,194,.22); border-radius:999px; background:rgba(255,255,255,.97); color:#1f2328; box-shadow:0 6px 18px rgba(0,65,130,.14); font:700 11px/1.1 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor:pointer; }
  .rail-goobi { position:relative; display:block; width:19px; height:16px; border-radius:44% 56% 45% 55% / 48% 45% 55% 52%; background:#0a66c2; box-shadow:inset 0 1px rgba(255,255,255,.35); }
  .rail-goobi::before { content:""; position:absolute; left:5px; top:6px; width:2px; height:3px; background:#102a43; box-shadow:7px 0 #102a43; }
  .rail-goobi::after { content:""; position:absolute; left:4px; bottom:-2px; width:4px; height:3px; border-radius:0 0 2px 2px; background:#0a66c2; box-shadow:8px 0 #0a66c2; }
  .outline { position:absolute; inset:2px; border:2px solid transparent; border-radius:10px; pointer-events:none; }
  :host([data-active="true"]) .outline { border-color:rgba(10,102,194,.72); box-shadow:0 0 0 4px rgba(112,181,249,.2),inset 0 0 0 1px rgba(255,255,255,.5); animation:pulse 1.25s ease-out 1; }
  :host([data-active="true"]) .edge { width:5px; opacity:.92; }
  .tag:hover { border-color:rgba(10,102,194,.5); transform:translateY(-1px); }
  .tag:focus-visible { outline:3px solid rgba(112,181,249,.45); outline-offset:2px; }
  @keyframes pulse { 0% { box-shadow:0 0 0 0 rgba(10,102,194,.38); } 100% { box-shadow:0 0 0 12px rgba(10,102,194,0); } }
  @media (prefers-reduced-motion: reduce) { .tag,.edge { transition:none; } :host([data-active="true"]) .outline { animation:none; } }
`;

function ensureRail(post: HTMLElement, opportunity: Opportunity): void {
  const prior = rails.get(opportunity.id);
  if (prior?.post === post && prior.host.isConnected) {
    updateRail(prior, opportunity);
    return;
  }
  if (prior) removeRail(opportunity.id);

  const computed = getComputedStyle(post).position;
  const changedPosition = computed === "static";
  const originalPosition = post.style.position;
  if (changedPosition) post.style.position = "relative";

  const host = document.createElement("goobi-li-rail");
  host.setAttribute("aria-hidden", "false");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = RAIL_CSS;
  const outline = document.createElement("span");
  outline.className = "outline";
  outline.setAttribute("aria-hidden", "true");
  const edge = document.createElement("span");
  edge.className = "edge";
  edge.setAttribute("aria-hidden", "true");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tag";
  button.addEventListener("click", () => {
    selectedId = opportunity.id;
    dockExpanded = true;
    renderDock();
    scrollToOpportunity(opportunity.id);
  });
  root.append(style, outline, edge, button);
  post.appendChild(host);
  const record = { post, host, root, changedPosition, originalPosition };
  rails.set(opportunity.id, record);
  updateRail(record, opportunity);
}

function updateRail(record: RailRecord, opportunity: Opportunity): void {
  const button = record.root.querySelector<HTMLButtonElement>(".tag");
  if (!button) return;
  button.replaceChildren();
  const dot = document.createElement("span");
  dot.className = "rail-goobi";
  dot.setAttribute("aria-hidden", "true");
  const score = document.createElement("span");
  const presentation = commentPresentation(opportunity);
  const railLabel = `${presentation.label} · Comment`;
  Object.assign(button.style, { background: presentation.bg, color: presentation.fg, borderColor: presentation.border });
  record.host.style.setProperty("--opportunity-accent", presentation.accent);
  score.textContent = railLabel;
  button.append(dot, score);
  button.setAttribute("aria-label", `Goobi comment opportunity on ${opportunity.author}'s post, ${railLabel.toLowerCase()}`);
  button.title = `${presentation.description} Open this opportunity in Goobi.`;
}

function removeRail(id: string): void {
  const record = rails.get(id);
  if (!record) return;
  record.host.remove();
  if (record.changedPosition && record.post.style.position === "relative") {
    record.post.style.position = record.originalPosition;
  }
  rails.delete(id);
  const timer = highlightTimers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  highlightTimers.delete(id);
}

function clearRails(): void {
  for (const id of [...rails.keys()]) removeRail(id);
}

function visiblePostFor(id: string): HTMLElement | null {
  const live = livePosts.get(id);
  if (live?.isConnected) {
    const extracted = extractPost(live);
    if (extracted?.id === id) return live;
  }
  for (const root of postRoots()) {
    const extracted = extractPost(root);
    if (!extracted) continue;
    livePosts.set(extracted.id, root);
    if (extracted.id === id) return root;
  }
  return null;
}

function scrollToOpportunity(id: string): void {
  const opportunity = opportunities.get(id);
  if (!opportunity) return;
  const post = visiblePostFor(id);
  if (!post) {
    showNotice("That post is not mounted in the feed. Scroll back until it appears, then choose View again.");
    return;
  }
  ensureRail(post, opportunity);
  post.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  const rail = rails.get(id);
  if (!rail) return;
  rail.host.dataset.active = "true";
  const old = highlightTimers.get(id);
  if (old !== undefined) window.clearTimeout(old);
  highlightTimers.set(id, window.setTimeout(() => {
    rail.host.dataset.active = "false";
    highlightTimers.delete(id);
  }, 2_200));
  window.setTimeout(() => rail.root.querySelector<HTMLButtonElement>(".tag")?.focus({ preventScroll: true }), 420);
}

const DOCK_CSS = `
  :host { all:initial; color-scheme:light; --li-blue:#0a66c2; --li-blue-deep:#004182; --li-sky:#70b5f9; --li-pale:#eaf3fb; --li-canvas:#f4f2ee; --li-white:#fff; --li-ink:#1f2328; --li-muted:#66737f; --li-border:#d0d7de; }
  * { box-sizing:border-box; }
  button,textarea,input { font:inherit; }
  button { -webkit-tap-highlight-color:transparent; }
  .dock { width:360px; max-height:calc(100vh - 96px); display:flex; flex-direction:column; overflow:hidden; border:1px solid rgba(0,65,130,.18); border-radius:20px; background:rgba(255,255,255,.98); color:var(--li-ink); box-shadow:0 22px 60px rgba(0,65,130,.2),0 2px 8px rgba(31,35,40,.08); font:13px/1.42 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; backdrop-filter:blur(16px); }
  .launcher { display:flex; align-items:center; gap:9px; min-height:50px; padding:7px 12px 7px 8px; border:1px solid rgba(10,102,194,.24); border-radius:999px; background:#fff; color:var(--li-ink); box-shadow:0 12px 34px rgba(0,65,130,.2); cursor:pointer; font:750 12px/1 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .goobi-creature { position:relative; display:grid; place-items:center; flex:0 0 auto; width:47px; height:38px; border-radius:13px; background:linear-gradient(145deg,#f7fbff,var(--li-pale)); border:1px solid rgba(10,102,194,.12); overflow:visible; }
  .launcher .goobi-creature { width:47px; height:35px; border:0; background:transparent; }
  .goobi-stage { display:grid; place-items:center; min-width:44px; min-height:30px; }
  .gcv { display:block; image-rendering:pixelated; transform-origin:bottom center; }
  .g-bob { animation:g-bob 1.7s ease-in-out infinite; }
  .g-snooze { animation:g-snooze 3.8s ease-in-out infinite; }
  .g-wobble { animation:g-wobble 1.6s ease-in-out infinite; }
  .g-tada { animation:g-tada .9s ease-in-out infinite; }
  .g-think { animation:g-think 1.5s ease-in-out infinite; }
  .g-hunt { animation:g-hunt 1.1s ease-in-out infinite; }
  @keyframes g-bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-9%)} }
  @keyframes g-snooze { 0%,100%{transform:scale(1,1) rotate(-3deg)} 50%{transform:scale(1.03,1.06) rotate(3deg)} }
  @keyframes g-wobble { 0%,100%{transform:rotate(-5deg)} 50%{transform:rotate(5deg)} }
  @keyframes g-tada { 0%,100%{transform:scale(1) rotate(0)} 20%{transform:scale(1.12) rotate(-7deg)} 40%,60%,80%{transform:scale(1.14) rotate(7deg)} 50%,70%{transform:scale(1.14) rotate(-7deg)} }
  @keyframes g-think { 0%,100%{transform:translateY(0) scale(1,1)} 50%{transform:translateY(-5%) scale(1.02,1.03)} }
  @keyframes g-hunt { 0%{transform:translateX(-7%) translateY(0)} 25%{transform:translateX(-7%) translateY(-9%)} 50%{transform:translateX(7%) translateY(0)} 75%{transform:translateX(7%) translateY(-9%)} 100%{transform:translateX(-7%) translateY(0)} }
  .head { display:flex; align-items:center; gap:10px; min-height:70px; padding:11px 12px; border-bottom:1px solid rgba(10,102,194,.12); background:linear-gradient(135deg,#f7fbff 0%,var(--li-pale) 64%,#fff 100%); }
  .brand { min-width:0; flex:1; }
  .eyebrow { color:var(--li-blue-deep); font-size:10px; font-weight:850; letter-spacing:.12em; text-transform:uppercase; }
  .title { margin-top:2px; font:790 16px/1.15 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:-.025em; }
  .goobi-status { margin-top:3px; color:var(--li-muted); font-size:10.5px; line-height:1.25; }
  .head-actions { display:flex; gap:5px; }
  .icon,.quiet,.primary,.danger,.chip { min-height:32px; border:1px solid var(--li-border); border-radius:9px; background:#fff; color:#38434f; cursor:pointer; font-weight:720; }
  .icon { width:32px; padding:0; font-size:15px; }
  .body { min-height:0; overflow:auto; overscroll-behavior:contain; padding:12px; background:linear-gradient(180deg,#fff,var(--li-canvas)); }
  .stats { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:10px; }
  .count { font-size:12px; color:var(--li-muted); }
  .count strong { color:var(--li-ink); font-size:18px; letter-spacing:-.03em; }
  .pending-count { color:var(--li-blue-deep); font-weight:800; }
  .tools { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:6px; }
  .review-queue { display:grid; gap:7px; margin:0 0 10px; padding:9px; border:1px solid rgba(10,102,194,.2); border-radius:12px; background:var(--li-pale); }
  .review-queue > strong { color:var(--li-blue-deep); font-size:11px; }
  .review-row { display:flex; align-items:center; gap:7px; padding:7px; border-radius:9px; background:#fff; }
  .review-copy { min-width:0; flex:1; }
  .review-copy b { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--li-ink); font-size:11px; }
  .review-copy span { display:block; color:var(--li-muted); font-size:9.5px; }
  .quiet,.primary,.danger,.chip { padding:6px 9px; font-size:11px; }
  .primary { border-color:var(--li-blue); background:var(--li-blue); color:white; }
  .danger { color:var(--li-blue-deep); border-color:rgba(10,102,194,.28); background:var(--li-pale); }
  .banner { margin-bottom:10px; padding:10px 11px; border:1px solid rgba(10,102,194,.2); border-radius:12px; background:var(--li-pale); color:#284b69; font-size:12px; }
  .banner strong { display:block; margin-bottom:2px; color:var(--li-blue-deep); }
  .list { display:grid; gap:8px; }
  .card { position:relative; overflow:hidden; border:1px solid rgba(0,65,130,.13); border-radius:14px; background:#fff; box-shadow:0 3px 12px rgba(0,65,130,.05); }
  .card::before { content:""; position:absolute; inset:0 auto 0 0; width:3px; background:var(--opportunity-accent,var(--li-blue)); opacity:.88; }
  .card.selected { border-color:rgba(10,102,194,.44); box-shadow:0 0 0 3px rgba(112,181,249,.18); }
  .card.in-review { border-color:rgba(10,102,194,.34); background:linear-gradient(145deg,#fff,var(--li-pale)); }
  .card-main { padding:10px 11px 8px 13px; }
  .meta { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .author-wrap { min-width:0; display:flex; align-items:center; gap:8px; }
  .avatar { position:relative; display:grid; place-items:center; flex:0 0 auto; width:31px; height:31px; overflow:hidden; border:1px solid rgba(10,102,194,.16); border-radius:50%; background:linear-gradient(145deg,var(--li-sky),var(--li-blue)); color:#fff; font-size:12px; font-weight:850; }
  .avatar.small { width:25px; height:25px; font-size:10px; }
  .avatar img { position:absolute; inset:0; width:100%; height:100%; border-radius:inherit; object-fit:cover; }
  .author { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--li-ink); font-weight:800; }
  .score { flex:0 0 auto; padding:3px 7px; border-radius:999px; background:var(--li-pale); color:var(--li-blue-deep); font-size:10px; font-weight:850; white-space:nowrap; }
  .review-state { margin-top:8px; display:inline-flex; align-items:center; gap:5px; padding:4px 7px; border-radius:999px; background:var(--li-pale); color:var(--li-blue-deep); font-size:10px; font-weight:850; }
  .review-state::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--li-blue); }
  .excerpt { display:-webkit-box; margin-top:6px; overflow:hidden; color:#52606c; font-size:12px; line-height:1.42; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .reason { margin-top:7px; color:#34495e; font-size:11px; font-weight:700; }
  .guidance { display:grid; gap:5px; margin-top:8px; padding:8px 9px; border-radius:10px; background:#f3f6f8; color:#52606c; font-size:11px; }
  .guidance span { color:var(--li-blue-deep); font-size:9px; font-weight:850; letter-spacing:.05em; text-transform:uppercase; }
  .actions { display:flex; flex-wrap:wrap; gap:6px; padding:0 10px 10px 13px; }
  .actions .primary { flex:1; }
  .empty { padding:24px 16px; border:1px dashed rgba(10,102,194,.22); border-radius:16px; text-align:center; color:var(--li-muted); background:rgba(255,255,255,.7); }
  .empty-mark { margin:0 auto 10px; width:42px; height:42px; display:grid; place-items:center; border-radius:15px; background:linear-gradient(145deg,#fff,var(--li-pale)); color:var(--li-blue); font-size:20px; }
  .empty strong { display:block; margin-bottom:4px; color:var(--li-ink); }
  .setup { padding:18px 14px 16px; }
  .setup h2 { margin:0 0 6px; font-size:17px; letter-spacing:-.025em; }
  .setup p { margin:0 0 14px; color:var(--li-muted); font-size:12px; }
  .setup .primary { width:100%; min-height:38px; }
  .draft { margin-bottom:10px; padding:10px; border:1px solid rgba(10,102,194,.25); border-radius:15px; background:linear-gradient(145deg,var(--li-pale),#fff); }
  .draft-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
  .draft-person { min-width:0; display:flex; align-items:center; gap:7px; }
  .draft-head strong { font-size:12px; }
  .draft-state { color:var(--li-muted); font-size:10px; }
  .draft textarea,.draft input { display:block; width:100%; padding:9px 10px; border:1px solid var(--li-border); border-radius:11px; background:white; color:var(--li-ink); line-height:1.45; }
  .draft textarea { min-height:104px; resize:vertical; }
  .draft input { margin-top:8px; font-size:11px; }
  .steer-label { display:block; margin-top:9px; color:#455564; font-size:10px; font-weight:800; letter-spacing:.03em; }
  .steer-hint { margin-top:5px; color:var(--li-muted); font-size:10px; line-height:1.35; }
  .draft textarea:focus,.draft input:focus { outline:3px solid rgba(112,181,249,.28); border-color:var(--li-blue); }
  .draft-actions { display:flex; gap:6px; margin-top:8px; }
  .draft-actions .primary { flex:1; }
  .safety { margin-top:7px; color:var(--li-muted); font-size:10px; }
  .error { margin-top:7px; color:#8a2d21; font-size:11px; }
  .toast { margin:0 12px 12px; padding:9px 10px; border-radius:11px; background:var(--li-blue-deep); color:white; font-size:11px; box-shadow:0 10px 24px rgba(0,65,130,.2); }
  .foot { padding:9px 12px 11px; border-top:1px solid rgba(10,102,194,.1); color:var(--li-muted); font-size:10px; background:#fff; }
  button:hover:not(:disabled) { filter:brightness(.98); transform:translateY(-1px); }
  button:disabled { opacity:.52; cursor:not-allowed; }
  button:focus-visible,.launcher:focus-visible { outline:3px solid rgba(112,181,249,.48); outline-offset:2px; }
  @media (max-width:760px) { .dock { width:min(360px,calc(100vw - 24px)); max-height:calc(100vh - 80px); } }
  @media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition:none!important; animation:none!important; } button:hover:not(:disabled) { transform:none; } }
`;

function ensureDock(): ShadowRoot {
  if (dockHost?.isConnected && dockRoot) return dockRoot;
  dockHost = document.createElement("goobi-li-dock");
  dockHost.style.cssText = "position:fixed;right:18px;top:76px;z-index:2147483000;display:block;max-width:calc(100vw - 24px);";
  dockHost.setAttribute("data-goobi-platform", PLATFORM);
  dockRoot = dockHost.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = DOCK_CSS;
  dockRoot.appendChild(style);
  document.documentElement.appendChild(dockHost);
  return dockRoot;
}

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  if (title) element.title = title;
  element.addEventListener("click", onClick);
  return element;
}

function sortedOpportunities(): Opportunity[] {
  const candidates = [...opportunities.values()]
    .filter((opportunity) => !postedIds.has(opportunity.id));
  const ranked = rankLinkedInOpportunities(candidates, recentCommentActivity, relationshipRules);
  for (const opportunity of candidates) opportunity.relationshipNote = undefined;
  for (const result of ranked) result.item.relationshipNote = result.relationshipNote;
  return ranked.map((result) => result.item);
}

function syncOpportunityRails(): void {
  const visibleIds = new Set(sortedOpportunities().map((opportunity) => opportunity.id));
  for (const [id, opportunity] of opportunities) {
    const post = livePosts.get(id);
    if (visibleIds.has(id) && post?.isConnected) ensureRail(post, opportunity);
    else removeRail(id);
  }
}

function commentPresentation(opportunity: Opportunity) {
  const tone = opportunity.decision === "needs_detail" ? "attention"
    : opportunity.score >= 0.82 ? "top" : opportunity.score >= 0.7 ? "good" : "low";
  const presentation = opportunityPresentation(tone, "light");
  return { ...presentation,
    label: opportunity.decision === "needs_detail" ? "Add your detail" : presentation.label,
    description: opportunity.decision === "needs_detail"
      ? "Add a real example or experience before Goobi can draft this comment." : presentation.description,
  };
}

function avatarInitial(author: string): string {
  return Array.from(author.trim())[0]?.toUpperCase() || "L";
}

function createAvatar(opportunity: Pick<Opportunity, "author" | "avatar">, small = false): HTMLElement {
  const fallback = document.createElement("span");
  fallback.className = `avatar${small ? " small" : ""}`;
  fallback.textContent = avatarInitial(opportunity.author);
  fallback.setAttribute("aria-hidden", "true");
  if (!opportunity.avatar) return fallback;
  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.src = opportunity.avatar;
  image.addEventListener("error", () => image.remove(), { once: true });
  fallback.appendChild(image);
  return fallback;
}

function goobiPresentation(): { mood: GoobiMood; status: string } {
  if (Date.now() < confirmedReactionUntil) return { mood: "cheer", status: "Commented" };
  if (scoringError || draft?.state === "error") return { mood: "worn", status: "Needs a little help" };
  if (paused) return { mood: "sleeping", status: "Resting. Scanning is off." };
  if (draft?.state === "drafting") return { mood: "thinking", status: "Writing this one…" };
  if (pendingIds.size) return { mood: "thinking", status: `${pendingIds.size} copied · waiting for your post mark` };
  if (inFlight.size || flushInProgress || queue.length) return { mood: "searching", status: "Reading visible posts…" };
  const surfaced = sortedOpportunities();
  const ready = surfaced.filter((opportunity) => opportunity.decision === "comment").length;
  const detail = surfaced.filter((opportunity) => opportunity.decision === "needs_detail").length;
  if (ready || detail) {
    const parts = [ready ? `${ready} ready` : "", detail ? `${detail} needs your detail` : ""].filter(Boolean);
    return { mood: "idle", status: parts.join(" · ") };
  }
  if (scoredPostCount) return { mood: "sleeping", status: `${scoredPostCount} checked. Keep scrolling.` };
  return { mood: "sleeping", status: "All quiet here" };
}

function createGoobiCreature(mood: GoobiMood): HTMLElement {
  const creature = document.createElement("span");
  creature.className = "goobi-creature";
  creature.setAttribute("aria-hidden", "true");
  const stage = document.createElement("span");
  stage.className = "goobi-stage";
  creature.appendChild(stage);
  liGoobiHandle = mountGoobi(stage, {
    cell: 2,
    reducedMotion: reducedMotionQuery.matches,
    palette: { body: LI_BLUE, worn: LI_BLUE_DEEP, love: LI_SKY, eye: "#102a43", highlight: "#ffffff" },
  });
  liGoobiHandle.setMood(mood);
  return creature;
}

function renderLauncher(root: ShadowRoot): void {
  const presentation = goobiPresentation();
  const launcher = button("", "launcher", () => {
    dockExpanded = true;
    renderDock();
  });
  launcher.setAttribute("aria-label", `Open Goobi LinkedIn copilot. ${presentation.status}`);
  const creature = createGoobiCreature(presentation.mood);
  const label = document.createElement("span");
  label.textContent = presentation.status;
  launcher.append(creature, label);
  root.appendChild(launcher);
}

function renderHeader(container: HTMLElement): void {
  const presentation = goobiPresentation();
  const header = document.createElement("div");
  header.className = "head";
  const creature = createGoobiCreature(presentation.mood);
  const brand = document.createElement("div");
  brand.className = "brand";
  const eyebrow = document.createElement("div");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Goobi · LinkedIn";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = paused ? "Taking a quiet break" : "Comment opportunities";
  const status = document.createElement("div");
  status.className = "goobi-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = presentation.status;
  brand.append(eyebrow, title, status);
  const actions = document.createElement("div");
  actions.className = "head-actions";
  if (consented && hasKey && enabled) {
    const pause = button(paused ? "▶" : "Ⅱ", "icon", () => void setPaused(!paused), paused ? "Resume LinkedIn copilot" : "Pause LinkedIn copilot");
    pause.setAttribute("aria-label", paused ? "Resume LinkedIn copilot" : "Pause LinkedIn copilot");
    actions.appendChild(pause);
  }
  const collapse = button("–", "icon", () => {
    dockExpanded = false;
    renderDock();
  }, "Minimize Goobi");
  collapse.setAttribute("aria-label", "Minimize Goobi");
  actions.appendChild(collapse);
  header.append(creature, brand, actions);
  container.appendChild(header);
}

function setupCopy(): { title: string; detail: string } {
  if (!consented) return { title: "Review LinkedIn data use", detail: "Choose what Goobi may read and send for scoring before the LinkedIn copilot starts." };
  if (!hasKey) return { title: "Connect Claude", detail: "Add your Anthropic key. LinkedIn uses your shared conversation focus, voice, and SOUL.md." };
  if (!focusReady) return { title: "Add your LinkedIn comment thesis", detail: "Tell Goobi which people and posts matter, and what you can credibly add, before feed scanning starts." };
  return { title: "LinkedIn copilot is off", detail: "Turn it on from the Goobi side panel when you want comment suggestions here." };
}

async function openSetup(): Promise<void> {
  const response = await send<{ ok?: boolean }>({ type: "OPEN_SIDE_PANEL" });
  if (!response?.ok) showNotice("Open Goobi from the browser toolbar to finish setup.");
}

function renderSetup(container: HTMLElement): void {
  const copy = setupCopy();
  const body = document.createElement("div");
  body.className = "setup";
  const title = document.createElement("h2");
  title.textContent = copy.title;
  const detail = document.createElement("p");
  detail.textContent = copy.detail;
  const action = button("Open Goobi side panel", "primary", () => void openSetup());
  body.append(title, detail, action);
  container.appendChild(body);
}

function beginDetailDraft(id: string): void {
  const opportunity = opportunities.get(id);
  if (!opportunity || opportunity.decision !== "needs_detail") return;
  selectedId = id;
  const request = ++requestSequence;
  draft = { id, state: "ready", text: "", steer: "", personalDetail: "", request };
  renderDock();
}

function renderDraft(body: HTMLElement): void {
  if (!draft) return;
  const opportunity = opportunities.get(draft.id);
  if (!opportunity) return;
  const awaitingRequiredDetail = opportunity.decision === "needs_detail" && draft.state !== "drafting" && !draft.text.trim();
  const panel = document.createElement("section");
  panel.className = "draft";
  panel.setAttribute("aria-label", `Draft comment for ${opportunity.author}`);
  const head = document.createElement("div");
  head.className = "draft-head";
  const person = document.createElement("div");
  person.className = "draft-person";
  const title = document.createElement("strong");
  title.textContent = `Draft · ${opportunity.author}`;
  person.append(createAvatar(opportunity, true), title);
  const state = document.createElement("span");
  state.className = "draft-state";
  state.textContent = draft.state === "drafting"
    ? "Goobi is writing…"
    : draft.state === "error"
      ? "Needs attention"
      : awaitingRequiredDetail
        ? "Needs your detail"
        : "Copy only";
  head.append(person, state);
  panel.appendChild(head);

  if (draft.state === "drafting") {
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.textContent = "Building a specific comment from this post and your saved Goobi voice…";
    banner.setAttribute("role", "status");
    panel.appendChild(banner);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = draft.text;
    textarea.dataset.preserveFocus = "draft-text";
    textarea.placeholder = awaitingRequiredDetail ? "Add one real detail below, then draft the comment." : "Your draft will appear here.";
    textarea.setAttribute("aria-label", "LinkedIn comment draft");
    textarea.addEventListener("input", () => {
      if (draft?.id === opportunity.id) draft.text = textarea.value;
    });
    textarea.addEventListener("keydown", (event) => event.stopPropagation());
    panel.appendChild(textarea);
    const detailLabel = document.createElement("label");
    detailLabel.className = "steer-label";
    detailLabel.textContent = awaitingRequiredDetail ? "Real detail from you (required)" : "Real detail from you (optional)";
    const personalDetail = document.createElement("textarea");
    personalDetail.value = draft.personalDetail;
    personalDetail.rows = 2;
    personalDetail.maxLength = 700;
    personalDetail.dataset.preserveFocus = "draft-detail";
    personalDetail.placeholder = "A fact, experience, or example Goobi may safely use for this comment…";
    personalDetail.setAttribute("aria-label", "Real personal detail for this LinkedIn comment");
    personalDetail.addEventListener("input", () => {
      if (draft?.id === opportunity.id) draft.personalDetail = personalDetail.value;
    });
    personalDetail.addEventListener("keydown", (event) => event.stopPropagation());
    const detailHint = document.createElement("div");
    detailHint.className = "steer-hint";
    detailHint.textContent = awaitingRequiredDetail
      ? `${opportunity.missingDetailPrompt || "Add the exact fact or experience Goobi may safely use."} Sent only for this draft and not stored.`
      : "Sent only for this draft and not stored. Without it, Goobi will reason from the post instead of inventing your experience.";
    panel.append(detailLabel, personalDetail, detailHint);
    const steerLabel = document.createElement("label");
    steerLabel.className = "steer-label";
    steerLabel.textContent = awaitingRequiredDetail ? "Draft instruction (optional)" : "Redraft instruction";
    const steer = document.createElement("input");
    steer.type = "text";
    steer.value = draft.steer;
    steer.dataset.preserveFocus = "draft-steer";
    steer.placeholder = "Tighter, more technical, ask one question…";
    steer.setAttribute("aria-label", "Steer the LinkedIn comment draft");
    steer.addEventListener("input", () => {
      if (draft?.id === opportunity.id) draft.steer = steer.value;
    });
    steer.addEventListener("keydown", (event) => event.stopPropagation());
    panel.append(steerLabel, steer);
    const steerHint = document.createElement("div");
    steerHint.className = "steer-hint";
    steerHint.textContent = "Uses the edited draft above as the rewrite base and replaces it with a new version.";
    panel.appendChild(steerHint);
    const actions = document.createElement("div");
    actions.className = "draft-actions";
    const copy = button("Copy & review", "primary", () => void copyAndReviewDraft(opportunity.id, textarea.value));
    copy.disabled = !textarea.value.trim();
    const retryLabel = () => awaitingRequiredDetail
      ? "Draft with detail"
      : steer.value.trim() ? "Redraft with instruction" : "Redraft";
    const retry = button(retryLabel(), "quiet", () => void draftComment(opportunity.id, steer.value, textarea.value, personalDetail.value));
    retry.disabled = paused || (awaitingRequiredDetail && !personalDetail.value.trim());
    textarea.addEventListener("input", () => { copy.disabled = !textarea.value.trim(); });
    personalDetail.addEventListener("input", () => { retry.disabled = paused || (awaitingRequiredDetail && !personalDetail.value.trim()); });
    steer.addEventListener("input", () => { retry.textContent = retryLabel(); });
    const close = button("Close", "quiet", () => {
      requestSequence += 1;
      draft = null;
      renderDock();
    });
    actions.append(copy, retry, close);
    panel.appendChild(actions);
  }
  if (draft.error) {
    const error = document.createElement("div");
    error.className = "error";
    error.textContent = draft.error;
    error.setAttribute("role", "alert");
    panel.appendChild(error);
  }
  const safety = document.createElement("div");
  safety.className = "safety";
  safety.textContent = "Goobi only copies and highlights the exact post. It never opens, fills, or submits LinkedIn's comment box.";
  panel.appendChild(safety);
  body.appendChild(panel);
}

function renderOpportunityCard(opportunity: Opportunity): HTMLElement {
  const card = document.createElement("article");
  const inReview = pendingIds.has(opportunity.id);
  card.className = `card${selectedId === opportunity.id ? " selected" : ""}${inReview ? " in-review" : ""}`;
  const main = document.createElement("div");
  main.className = "card-main";
  const meta = document.createElement("div");
  meta.className = "meta";
  const authorWrap = document.createElement("div");
  authorWrap.className = "author-wrap";
  const author = document.createElement("div");
  author.className = "author";
  author.textContent = opportunity.author;
  authorWrap.append(createAvatar(opportunity), author);
  const score = document.createElement("span");
  score.className = "score";
  const presentation = commentPresentation(opportunity);
  score.textContent = presentation.label;
  score.title = presentation.description;
  Object.assign(score.style, { background: presentation.bg, color: presentation.fg, border: `1px solid ${presentation.border}` });
  card.style.setProperty("--opportunity-accent", presentation.accent);
  meta.append(authorWrap, score);
  const excerpt = document.createElement("div");
  excerpt.className = "excerpt";
  excerpt.textContent = opportunity.text;
  const reason = document.createElement("div");
  reason.className = "reason";
  reason.textContent = `Post · ${opportunity.postReason}`;
  main.append(meta, excerpt, reason);
  const person = document.createElement("div");
  person.className = "reason person-reason";
  person.textContent = `Person · ${opportunity.personReason}`;
  main.appendChild(person);
  if (inReview) {
    const reviewState = document.createElement("div");
    reviewState.className = "review-state";
    reviewState.textContent = "Copied · waiting for you to post";
    main.appendChild(reviewState);
  }
  if (opportunity.anchor || opportunity.replyBrief || opportunity.relationshipNote) {
    const guidance = document.createElement("div");
    guidance.className = "guidance";
    if (opportunity.anchor) {
      const anchor = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = "Engage";
      anchor.append(label, document.createTextNode(` ${opportunity.anchor}`));
      guidance.appendChild(anchor);
    }
    if (opportunity.replyBrief) {
      const move = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = `Useful move · ${opportunity.commentLane.replace(/_/g, " ")}`;
      move.append(label, document.createTextNode(` ${opportunity.replyBrief}`));
      guidance.appendChild(move);
    }
    if (opportunity.decision === "needs_detail" && opportunity.missingDetailPrompt) {
      const needed = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = "Add from you";
      needed.append(label, document.createTextNode(` ${opportunity.missingDetailPrompt}`));
      guidance.appendChild(needed);
    }
    if (opportunity.relationshipNote) {
      const history = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = "Relationship spacing";
      history.append(label, document.createTextNode(` ${opportunity.relationshipNote}`));
      guidance.appendChild(history);
    }
    main.appendChild(guidance);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const draftButton = opportunity.decision === "needs_detail"
    ? button("Add your detail", "primary", () => beginDetailDraft(opportunity.id))
    : button("Draft comment", "primary", () => void draftComment(opportunity.id));
  draftButton.disabled = paused || draft?.state === "drafting";
  const view = button("View", "quiet", () => {
    selectedId = opportunity.id;
    renderDock();
    scrollToOpportunity(opportunity.id);
  }, "Scroll to and highlight this exact feed post");
  const posted = button(inReview ? "Mark posted" : "I already commented", inReview ? "danger" : "quiet", () => void markPosted(opportunity.id), "Record this comment only after it is live on LinkedIn");
  const dismiss = inReview
    ? button("Not posted", "quiet", () => void dismissReview(opportunity.id), "Remove the in-review receipt without changing confirmed activity")
    : null;
  const skip = button("Skip", "quiet", () => skipOpportunity(opportunity.id), "Remove this suggestion for the current session");
  actions.append(draftButton, view, posted);
  if (dismiss) actions.appendChild(dismiss);
  if (!inReview) actions.appendChild(skip);
  card.append(main, actions);
  return card;
}

function renderOrphanedReviews(body: HTMLElement): void {
  const orphaned = [...pendingReviews.values()]
    .filter((review) => !opportunities.has(review.postId))
    .sort((left, right) => right.lastCopiedAt - left.lastCopiedAt);
  if (!orphaned.length) return;
  const queue = document.createElement("section");
  queue.className = "review-queue";
  queue.setAttribute("aria-label", "Copied comments still in review");
  const heading = document.createElement("strong");
  heading.textContent = `${orphaned.length} copied ${orphaned.length === 1 ? "comment is" : "comments are"} still in review`;
  queue.appendChild(heading);
  for (const review of orphaned) {
    const row = document.createElement("div");
    row.className = "review-row";
    const copy = document.createElement("div");
    copy.className = "review-copy";
    const author = document.createElement("b");
    author.textContent = review.author;
    const state = document.createElement("span");
    state.textContent = "Copied · waiting for your post mark";
    copy.append(author, state);
    row.append(
      copy,
      button("Mark posted", "danger", () => void markPosted(review.postId), "Record only after the comment is live on LinkedIn"),
      button("Not posted", "quiet", () => void dismissReview(review.postId), "Remove this in-review receipt"),
    );
    queue.appendChild(row);
  }
  body.appendChild(queue);
}

function renderReadyBody(container: HTMLElement): void {
  const body = document.createElement("div");
  body.className = "body";
  if (paused) {
    const banner = document.createElement("div");
    banner.className = "banner";
    const title = document.createElement("strong");
    title.textContent = "Scanning is paused";
    const detail = document.createTextNode("No new post text is being sent. Your current opportunities and draft stay available.");
    banner.append(title, detail);
    body.appendChild(banner);
  }
  renderDraft(body);

  if (scoringError) {
    const error = document.createElement("div");
    error.className = "banner";
    error.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = "Scanning needs attention";
    const detail = document.createTextNode(`${scoringError} Your saved opportunities are unchanged.`);
    const retry = button("Retry scan", "quiet", retryScoring);
    retry.disabled = paused;
    retry.style.marginTop = "8px";
    error.append(title, detail, retry);
    body.appendChild(error);
  }

  const items = sortedOpportunities();
  const readyCount = items.filter((opportunity) => opportunity.decision === "comment").length;
  const detailCount = items.filter((opportunity) => opportunity.decision === "needs_detail").length;
  const diversityHeldCount = Math.max(0, opportunities.size - items.length);
  const notSelectedCount = skippedPostCount + policyBlockedPostCount + diversityHeldCount;
  const stats = document.createElement("div");
  stats.className = "stats";
  const count = document.createElement("div");
  count.className = "count";
  const strong = document.createElement("strong");
  strong.textContent = String(readyCount);
  count.append(strong, document.createTextNode(" ready"));
  if (detailCount) count.append(document.createTextNode(` · ${detailCount} needs your detail`));
  if (scoredPostCount) count.append(document.createTextNode(` · ${scoredPostCount} checked`));
  if (notSelectedCount) count.append(document.createTextNode(` · ${notSelectedCount} not selected`));
  if (inFlight.size || queue.length) count.append(document.createTextNode(` · ${inFlight.size + queue.length} ${scoringError ? "waiting to retry" : "scoring"}`));
  if (pendingIds.size) {
    const pending = document.createElement("span");
    pending.className = "pending-count";
    pending.textContent = ` · ${pendingIds.size} in review`;
    count.appendChild(pending);
  }
  const tools = document.createElement("div");
  tools.className = "tools";
  const rescanButton = button("Rescan", "quiet", () => rescan(), "Clear this pass and rescore visible LinkedIn feed posts");
  rescanButton.disabled = paused;
  tools.appendChild(rescanButton);
  if (items.length) {
    tools.appendChild(button("Clear all ready", "quiet", clearAllReadyOpportunities, "Clear every ready opportunity from this session without changing in-review or confirmed activity"));
  }
  if (pendingIds.size) {
    tools.appendChild(button("Clear all in review", "quiet", () => void clearAllPendingReviews(), "Dismiss every copied in-review receipt without changing confirmed activity"));
  }
  if (undoReceipt) {
    tools.appendChild(button("Undo last mark", "quiet", () => void undoLastPosted(), "Restore the most recently marked opportunity"));
  }
  stats.append(count, tools);
  body.appendChild(stats);
  renderOrphanedReviews(body);

  if (items.length) {
    const list = document.createElement("div");
    list.className = "list";
    items.forEach((opportunity) => list.appendChild(renderOpportunityCard(opportunity)));
    body.appendChild(list);
  } else {
    const empty = document.createElement("div");
    empty.className = "empty";
    const scanning = !scoringError && !paused && Boolean(inFlight.size || queue.length || flushInProgress);
    const mark = document.createElement("div");
    mark.className = "empty-mark";
    mark.textContent = scanning ? "…" : "✦";
    const title = document.createElement("strong");
    const detail = document.createTextNode("");
    if (scoringError) {
      title.textContent = "Waiting for your retry";
      detail.textContent = "Automatic scanning has stopped. Use Retry scan above to continue.";
    } else if (paused) {
      title.textContent = "Ready when you resume";
      detail.textContent = "Resume scanning to look for comment opportunities.";
    } else if (scanning) {
      title.textContent = "Reading this part of the feed";
      detail.textContent = "Goobi is checking every visible post and will keep only strong matches.";
    } else if (!visibleRootCount) {
      title.textContent = "No feed posts are visible yet";
      detail.textContent = "Let LinkedIn finish loading, then scroll normally or choose Rescan.";
    } else if (!extractablePostCount) {
      title.textContent = "LinkedIn is still loading post text";
      detail.textContent = "Scroll a little, then choose Rescan if the feed stays quiet.";
    } else if (scoredPostCount) {
      title.textContent = `${scoredPostCount} post${scoredPostCount === 1 ? "" : "s"} checked`;
      detail.textContent = "None cleared your comment quality bar. Keep scrolling for a better conversation.";
    } else {
      title.textContent = "Visible posts are ready to scan";
      detail.textContent = "Choose Rescan if results do not begin in a moment.";
    }
    empty.append(mark, title, detail);
    body.appendChild(empty);
  }
  container.appendChild(body);
}

function renderDock(): void {
  if (invalidated || !enabled || !isSupportedLinkedInUrl(location.href)) {
    liGoobiHandle?.destroy();
    liGoobiHandle = null;
    dockHost?.remove();
    dockHost = null;
    dockRoot = null;
    return;
  }
  const root = ensureDock();
  const priorBody = root.querySelector<HTMLElement>(".body");
  const priorScrollTop = priorBody?.scrollTop ?? 0;
  const priorActive = root.activeElement;
  const preserveKey = priorActive instanceof HTMLTextAreaElement || priorActive instanceof HTMLInputElement
    ? priorActive.dataset.preserveFocus
    : undefined;
  const selectionStart = priorActive instanceof HTMLTextAreaElement || priorActive instanceof HTMLInputElement
    ? priorActive.selectionStart
    : null;
  const selectionEnd = priorActive instanceof HTMLTextAreaElement || priorActive instanceof HTMLInputElement
    ? priorActive.selectionEnd
    : null;
  const style = root.querySelector("style");
  liGoobiHandle?.destroy();
  liGoobiHandle = null;
  root.replaceChildren();
  if (style) root.appendChild(style);
  if (!dockExpanded) {
    renderLauncher(root);
    return;
  }
  const container = document.createElement("aside");
  container.className = "dock";
  container.setAttribute("aria-label", "Goobi LinkedIn comment copilot");
  renderHeader(container);
  if (!consented || !hasKey || !focusReady) renderSetup(container);
  else renderReadyBody(container);
  if (notice) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = notice;
    toast.setAttribute("role", "status");
    container.appendChild(toast);
  }
  const foot = document.createElement("div");
  foot.className = "foot";
  foot.textContent = "Copy & review marks Commented and removes the opportunity · Undo is available";
  container.appendChild(foot);
  root.appendChild(container);
  const nextBody = root.querySelector<HTMLElement>(".body");
  if (nextBody) nextBody.scrollTop = priorScrollTop;
  if (preserveKey) {
    const nextActive = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-preserve-focus="${preserveKey}"]`);
    if (nextActive) {
      nextActive.focus({ preventScroll: true });
      if (selectionStart !== null && selectionEnd !== null) nextActive.setSelectionRange(selectionStart, selectionEnd);
    }
  }
}

function showNotice(message: string): void {
  notice = message;
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
  renderDock();
  noticeTimer = window.setTimeout(() => {
    notice = "";
    noticeTimer = undefined;
    renderDock();
  }, 4_500);
}

async function copyDraft(text: string): Promise<boolean> {
  const value = text.trim();
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    showNotice("Clipboard access failed. Select the draft text and copy it manually.");
    return false;
  }
}

async function copyAndReviewDraft(id: string, text: string): Promise<void> {
  if (!(await copyDraft(text))) return;
  if (invalidated || !enabled || !consented) {
    showNotice("Draft copied, but LinkedIn activity is off, so it was not marked Commented.");
    return;
  }
  const opportunity = opportunities.get(id);
  if (!opportunity) {
    showNotice("Draft copied, but that post is no longer in the current feed view.");
    return;
  }
  if (visiblePostFor(id)) scrollToOpportunity(id);
  const marked = await markPosted(id, "copy");
  if (!marked) showNotice("Draft copied, but Goobi could not mark it Commented. The opportunity was kept so you can retry.");
}

async function dismissReview(id: string): Promise<void> {
  if (invalidated) return;
  const response = await send<{ ok?: boolean; log?: unknown; error?: string }>({
    type: "LI_DISMISS_COMMENT_REVIEW",
    postId: id,
  });
  if (!response?.ok) {
    showNotice("Could not remove the in-review receipt. Try again.");
    return;
  }
  hydrateCommentLog(response.log);
  renderDock();
  showNotice("Removed from in review. Confirmed activity was not changed.");
}

function skipOpportunity(id: string): void {
  opportunities.delete(id);
  removeRail(id);
  if (selectedId === id) selectedId = sortedOpportunities()[0]?.id ?? "";
  if (draft?.id === id) {
    requestSequence += 1;
    draft = null;
  }
  renderDock();
  showNotice("Skipped for this session.");
}

function clearAllReadyOpportunities(): void {
  const count = opportunities.size;
  if (!count) return;
  requestSequence += 1;
  draft = null;
  selectedId = "";
  for (const id of [...opportunities.keys()]) removeRail(id);
  opportunities.clear();
  renderDock();
  showNotice(`Cleared ${count} ready comment ${count === 1 ? "opportunity" : "opportunities"}. In-review and confirmed activity were not changed.`);
}

async function clearAllPendingReviews(): Promise<void> {
  if (invalidated || !pendingIds.size) return;
  const ids = [...pendingIds];
  let latestLog: unknown;
  let cleared = 0;
  for (const postId of ids) {
    const response = await send<{ ok?: boolean; log?: unknown }>({
      type: "LI_DISMISS_COMMENT_REVIEW",
      postId,
    });
    if (!response?.ok) continue;
    latestLog = response.log;
    cleared += 1;
  }
  if (latestLog !== undefined) hydrateCommentLog(latestLog);
  renderDock();
  showNotice(cleared === ids.length
    ? `Cleared ${cleared} in-review ${cleared === 1 ? "receipt" : "receipts"}. Confirmed activity was not changed.`
    : `Cleared ${cleared} of ${ids.length} in-review receipts. Try again for the rest.`);
}

async function draftComment(id: string, steer = "", currentDraft = "", personalDetail = ""): Promise<void> {
  if (!active || paused || invalidated || !isSupportedLinkedInUrl(location.href)) return;
  const opportunity = opportunities.get(id);
  if (!opportunity) return;
  if (opportunity.decision === "needs_detail" && !personalDetail.trim()) {
    showNotice("Add one real detail before drafting this comment.");
    return;
  }
  selectedId = id;
  const request = ++requestSequence;
  const callUrl = location.href;
  const normalizedSteer = cleanInline(steer, 500);
  const rewriteBase = currentDraft.trim().slice(0, 1_200);
  const normalizedPersonalDetail = personalDetail.trim().slice(0, 700);
  draft = { id, state: "drafting", text: rewriteBase, steer: normalizedSteer, personalDetail: normalizedPersonalDetail, request };
  renderDock();
  const response = await send<{ reply?: string; error?: string }>({
    type: "LI_DRAFT_COMMENT",
    author: opportunity.author,
    text: opportunity.text,
    context: opportunity.context,
    reason: opportunity.reason,
    category: opportunity.category,
    anchor: opportunity.anchor,
    replyMove: opportunity.replyMove,
    replyBrief: opportunity.replyBrief,
    authorHeadline: opportunity.authorHeadline,
    authorKind: opportunity.authorKind,
    connectionDegree: opportunity.connectionDegree,
    personReason: opportunity.personReason,
    commentLane: opportunity.commentLane,
    steer: normalizedSteer || undefined,
    currentDraft: rewriteBase || undefined,
    personalDetail: normalizedPersonalDetail || undefined,
    opportunityLine: "This is a LinkedIn feed comment. Write one specific, self-contained contribution. Avoid X/Twitter syntax, engagement bait, and claims about reach.",
  });
  if (invalidated || !active || paused || callUrl !== location.href || request !== requestSequence || draft?.request !== request) return;
  if (response?.error === "no-key") {
    hasKey = false;
    draft = null;
    deactivateScanning(false);
    renderDock();
    showNotice("Add your Anthropic key in the Goobi side panel.");
    return;
  }
  if (!response || response.error || !cleanInline(response.reply, 4_000)) {
    draft = {
      id,
      state: "error",
      text: rewriteBase,
      steer: normalizedSteer,
      personalDetail: normalizedPersonalDetail,
      error: response?.error === "linkedin-comment-quality"
        ? "Goobi rejected a generic draft. Add one real detail, sharpen the instruction, or try Redraft."
        : response?.error === "author-continuity"
          ? "Goobi blocked an unsupported claim about your experience. Add your current take and Redraft. Your edits are kept."
        : response?.error === "ungrounded-contribution"
          ? "Goobi could not ground a useful contribution. Add a real detail or ask for one specific implication of the post, then Redraft. Your edits are kept."
        : response?.error ? "Goobi could not draft this comment. Try again." : "The background worker did not return a draft. Try again.",
      request,
    };
  } else {
    draft = { id, state: "ready", text: response.reply!.trim(), steer: normalizedSteer, personalDetail: normalizedPersonalDetail, request };
  }
  renderDock();
}

function hydrateCommentLog(value: unknown): void {
  const log = normalizeCommentLog(value);
  recentCommentActivity = [...log.entries];
  postedIds.clear();
  pendingIds.clear();
  pendingReviews.clear();
  log.entries.forEach((entry) => postedIds.add(entry.postId));
  log.pending.forEach((entry) => {
    pendingIds.add(entry.postId);
    pendingReviews.set(entry.postId, entry);
  });
  for (const id of postedIds) {
    opportunities.delete(id);
    removeRail(id);
    if (draft?.id === id) draft = null;
  }
  syncOpportunityRails();
}

async function markPosted(id: string, source: "manual" | "copy" = "manual"): Promise<boolean> {
  if (invalidated || !enabled || !consented) return false;
  const opportunity = opportunities.get(id);
  const pending = pendingReviews.get(id);
  const author = opportunity?.author ?? pending?.author;
  const permalink = opportunity?.permalink ?? pending?.permalink;
  if (!author) return false;
  const wasPending = pendingIds.has(id);
  const response = await send<{ ok?: boolean; log?: unknown; event?: CommentLogEntry; error?: string }>({
    type: "LI_MARK_POSTED",
    postId: id,
    author,
    authorKey: opportunity?.authorKey,
    permalink,
  });
  if (!response?.ok || !response.event) {
    showNotice("Could not save completion. The opportunity was kept so you can retry.");
    return false;
  }
  hydrateCommentLog(response.log);
  undoReceipt = {
    event: { postId: response.event.postId, postedAt: response.event.postedAt },
    opportunity,
    review: { postId: id, author, ...(permalink ? { permalink } : {}) },
    wasPending,
  };
  if (draft?.id === id) {
    requestSequence += 1;
    draft = null;
  }
  confirmedReactionUntil = Date.now() + 1_800;
  if (confirmedReactionTimer !== undefined) window.clearTimeout(confirmedReactionTimer);
  confirmedReactionTimer = window.setTimeout(() => {
    confirmedReactionTimer = undefined;
    renderDock();
  }, 1_850);
  if (selectedId === id) selectedId = sortedOpportunities()[0]?.id ?? "";
  renderDock();
  showNotice(source === "copy"
    ? "Commented · copied for review and removed from the list. Undo is available above."
    : "Marked posted. You can undo the activity mark above.");
  return true;
}

async function undoLastPosted(): Promise<void> {
  const receipt = undoReceipt;
  if (!receipt || invalidated) return;
  const response = await send<{ ok?: boolean; log?: unknown; error?: string }>({
    type: "LI_UNDO_POSTED",
    postId: receipt.event.postId,
    postedAt: receipt.event.postedAt,
    ...(receipt.wasPending ? { author: receipt.review.author, permalink: receipt.review.permalink } : {}),
  });
  if (!response?.ok) {
    undoReceipt = null;
    showNotice("That activity mark changed elsewhere and can no longer be undone here.");
    return;
  }
  hydrateCommentLog(response.log);
  if (receipt.opportunity) {
    opportunities.set(receipt.opportunity.id, receipt.opportunity);
    const post = visiblePostFor(receipt.opportunity.id);
    if (post) ensureRail(post, receipt.opportunity);
    selectedId = receipt.opportunity.id;
  }
  undoReceipt = null;
  renderDock();
  showNotice(receipt.wasPending
    ? "Activity mark undone. The copied comment is back in review."
    : "Activity mark undone. No copied-comment receipt was created.");
}

function setPaused(value: boolean): void {
  if (paused === value) return;
  paused = value;
  void setLocal({ [CONFIG.LI_PAUSED_KEY]: value });
  if (paused) {
    generation += 1;
    queue = [];
    queuedIds.clear();
    inFlight.clear();
    if (draft?.state === "drafting") {
      requestSequence += 1;
      draft = { ...draft, state: "error", error: "Drafting stopped when you paused. Resume and choose Redraft to try again." };
    }
  } else {
    for (const [id, opportunity] of opportunities) {
      const post = visiblePostFor(id);
      if (post) ensureRail(post, opportunity);
    }
    requestScan();
  }
  renderDock();
  showNotice(paused ? "Paused. No LinkedIn post text will be sent." : "Resumed. Scanning the visible feed again.");
}

function rescan(): void {
  if (!active || paused) return;
  generation += 1;
  scoreCalls = 0;
  scoringError = "";
  resetScanReceipt();
  requestSequence += 1;
  draft = null;
  selectedId = "";
  queue = [];
  queuedIds.clear();
  inFlight.clear();
  seen.clear();
  opportunities.clear();
  livePosts.clear();
  clearRails();
  renderDock();
  scan();
  showNotice("Fresh pass started on the visible LinkedIn feed.");
}

function retainFailedScoreBatch(batch: readonly QueuedPost[]): void {
  // Keep the immutable visible snapshots for an explicit retry, even if the
  // feed has scrolled on. A failed request must not drain the rest of the queue.
  for (const post of [...batch].reverse()) {
    if (queuedIds.has(post.id) || seen.has(post.id) || postedIds.has(post.id)) continue;
    queuedIds.add(post.id);
    queue.unshift(post);
  }
}

function retryScoring(): void {
  if (!active || paused || invalidated) return;
  scoringError = "";
  scoreCalls = 0;
  queue = queue.map((post) => ({ ...post, scoreAttempts: 0 }));
  scan();
  showNotice("Retrying the scan. Your saved opportunities and edited draft are kept.");
}

function deactivateScanning(clearSession: boolean): void {
  active = false;
  bodyObserver?.disconnect();
  bodyObserver = null;
  if (scanTimer !== undefined) window.clearTimeout(scanTimer);
  scanTimer = undefined;
  if (flushTimer !== undefined) window.clearTimeout(flushTimer);
  flushTimer = undefined;
  generation += 1;
  queue = [];
  queuedIds.clear();
  inFlight.clear();
  requestSequence += 1;
  if (draft?.state === "drafting") {
    draft = { ...draft, state: "error", error: "Drafting stopped because your LinkedIn setup changed. Choose Redraft to use the current settings." };
  }
  clearRails();
  if (clearSession) {
    resetScanReceipt();
    seen.clear();
    opportunities.clear();
    livePosts.clear();
    selectedId = "";
    draft = null;
  }
}

function activateScanning(): void {
  if (active || invalidated || !brokerCompatible || !enabled || !consented || !hasKey || !focusReady || !isSupportedLinkedInUrl(location.href)) return;
  active = true;
  bodyObserver = new MutationObserver(() => requestScan());
  bodyObserver.observe(document.body, {
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "role", "href", "aria-label", "data-testid", "data-test-id", "data-view-name",
      "data-urn", "data-id", "data-entity-urn", "data-update-urn",
    ],
    subtree: true,
  });
  if (!paused) scan();
}

function startRouteWatcher(): void {
  if (urlPoll !== undefined || invalidated) return;
  lastUrl = location.href;
  urlPoll = window.setInterval(() => {
    if (invalidated || !contextOK()) {
      teardown();
      return;
    }
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    deactivateScanning(true);
    if (isSupportedLinkedInUrl(location.href)) {
      renderDock();
      activateScanning();
    } else {
      renderDock();
    }
  }, 500);
}

async function reconcileGate(): Promise<void> {
  const epoch = ++gateEpoch;
  const wasEnabled = enabled;
  const store = await getLocalMany([
    CONFIG.LI_DATA_CONSENT_KEY,
    CONFIG.LI_COPILOT_KEY,
    CONFIG.ANTHROPIC_KEY_KEY,
    CONFIG.LI_PAUSED_KEY,
    CONFIG.X_NICHE_KEY,
    CONFIG.LI_STRATEGY_KEY,
  ]);
  if (invalidated || epoch !== gateEpoch) return;
  consented = store[CONFIG.LI_DATA_CONSENT_KEY] === LI_CONSENT_VERSION;
  enabled = store[CONFIG.LI_COPILOT_KEY] === true;
  hasKey = typeof store[CONFIG.ANTHROPIC_KEY_KEY] === "string" && Boolean((store[CONFIG.ANTHROPIC_KEY_KEY] as string).trim());
  focusReady = Boolean(typeof store[CONFIG.X_NICHE_KEY] === "string" && (store[CONFIG.X_NICHE_KEY] as string).trim()) || linkedInStrategyConfigured(store[CONFIG.LI_STRATEGY_KEY]);
  paused = store[CONFIG.LI_PAUSED_KEY] === true;
  relationshipRules = normalizeLinkedInStrategy(store[CONFIG.LI_STRATEGY_KEY]).relationship;
  if (!enabled) {
    deactivateScanning(true);
    if (urlPoll !== undefined) window.clearInterval(urlPoll);
    urlPoll = undefined;
    renderDock();
    return;
  }
  startRouteWatcher();
  if (!consented || !hasKey || !focusReady || !isSupportedLinkedInUrl(location.href)) {
    deactivateScanning(!consented || !hasKey || !focusReady);
    renderDock();
    return;
  }
  if (!wasEnabled) scoreCalls = 0;
  activateScanning();
  renderDock();
}

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  if (area !== "local" || invalidated) return;
  if (changes[CONFIG.LI_COMMENT_LOG_KEY]) {
    hydrateCommentLog(changes[CONFIG.LI_COMMENT_LOG_KEY].newValue);
    renderDock();
  }
  if (changes[CONFIG.LI_STRATEGY_KEY]) {
    relationshipRules = normalizeLinkedInStrategy(changes[CONFIG.LI_STRATEGY_KEY].newValue).relationship;
  }
  if (changes[CONFIG.LI_PAUSED_KEY] && changes[CONFIG.LI_PAUSED_KEY].newValue !== paused) {
    paused = changes[CONFIG.LI_PAUSED_KEY].newValue === true;
    if (paused) {
      generation += 1;
      queue = [];
      queuedIds.clear();
      inFlight.clear();
      if (draft?.state === "drafting") {
        requestSequence += 1;
        draft = { ...draft, state: "error", error: "Drafting stopped when you paused. Resume and choose Redraft to try again." };
      }
    } else {
      requestScan();
    }
    renderDock();
  }
  if (
    changes[CONFIG.ANALYSIS_PROVIDER_KEY] || changes[CONFIG.JEV_ANALYSIS_CONSENT_KEY] || changes[CONFIG.TYPESAFE_KEY_KEY] ||
    changes[CONFIG.LI_DATA_CONSENT_KEY] ||
    changes[CONFIG.LI_COPILOT_KEY] ||
    changes[CONFIG.ANTHROPIC_KEY_KEY] ||
    changes[CONFIG.X_NICHE_KEY] ||
    changes[CONFIG.LI_STRATEGY_KEY] ||
    changes[CONFIG.LI_VOICE_KEY] ||
    changes[CONFIG.X_VOICE_KEY] ||
    changes[CONFIG.X_SOUL_KEY] ||
    changes[CONFIG.X_MY_HANDLE_KEY] ||
    changes[CONFIG.X_MY_POSTS_KEY]
  ) {
    const revoked =
      (changes[CONFIG.LI_DATA_CONSENT_KEY] && changes[CONFIG.LI_DATA_CONSENT_KEY].newValue !== LI_CONSENT_VERSION) ||
      (changes[CONFIG.LI_COPILOT_KEY] && changes[CONFIG.LI_COPILOT_KEY].newValue !== true) ||
      (changes[CONFIG.ANTHROPIC_KEY_KEY] && !String(changes[CONFIG.ANTHROPIC_KEY_KEY].newValue ?? "").trim()) ||
      (changes[CONFIG.X_NICHE_KEY] && !String(changes[CONFIG.X_NICHE_KEY].newValue ?? "").trim());
    // Invalidate synchronously before re-reading storage. Nonempty changes to
    // thesis, voice, or credentials are just as capable of making a response
    // stale as revocation; an old callback must not win that storage race.
    gateEpoch += 1;
    const strategyChanged = Boolean(changes[CONFIG.X_NICHE_KEY] || changes[CONFIG.LI_STRATEGY_KEY] || changes[CONFIG.ANALYSIS_PROVIDER_KEY] || changes[CONFIG.JEV_ANALYSIS_CONSENT_KEY] || changes[CONFIG.TYPESAFE_KEY_KEY]);
    deactivateScanning(Boolean(revoked) || strategyChanged);
    scoringError = "";
    if (strategyChanged || changes[CONFIG.ANTHROPIC_KEY_KEY]) scoreCalls = 0;
    void reconcileGate();
  }
}

function onVisibilityChanged(): void {
  if (!document.hidden) requestScan();
}

function onFeedScroll(): void {
  requestScan();
}

function onReducedMotionChanged(): void {
  if (!invalidated && enabled) renderDock();
}

function onWindowError(event: ErrorEvent): void {
  if (isContextInvalidated(event.error) || isContextInvalidated(event.message)) {
    teardown();
    event.preventDefault();
  }
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  if (isContextInvalidated(event.reason)) {
    teardown();
    event.preventDefault();
  }
}

function teardown(): void {
  if (invalidated) return;
  invalidated = true;
  deactivateScanning(true);
  if (urlPoll !== undefined) window.clearInterval(urlPoll);
  urlPoll = undefined;
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
  noticeTimer = undefined;
  if (confirmedReactionTimer !== undefined) window.clearTimeout(confirmedReactionTimer);
  confirmedReactionTimer = undefined;
  liGoobiHandle?.destroy();
  liGoobiHandle = null;
  try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* context already gone */ }
  document.removeEventListener("visibilitychange", onVisibilityChanged);
  window.removeEventListener("scroll", onFeedScroll);
  window.removeEventListener("error", onWindowError, true);
  window.removeEventListener("unhandledrejection", onUnhandledRejection);
  reducedMotionQuery.removeEventListener("change", onReducedMotionChanged);
  dockHost?.remove();
  dockHost = null;
  dockRoot = null;
  postedIds.clear();
  pendingIds.clear();
  pendingReviews.clear();
}

async function boot(): Promise<void> {
  chrome.storage.onChanged.addListener(onStorageChanged);
  document.addEventListener("visibilitychange", onVisibilityChanged);
  window.addEventListener("scroll", onFeedScroll, { passive: true });
  window.addEventListener("error", onWindowError, true);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  reducedMotionQuery.addEventListener("change", onReducedMotionChanged);
  hydrateCommentLog(await getLocal(CONFIG.LI_COMMENT_LOG_KEY));
  if (invalidated) return;
  const broker = await send<{ protocol?: number }>({ type: "LI_BROKER_STATUS" });
  if (invalidated) return;
  brokerCompatible = broker?.protocol === LI_BROKER_PROTOCOL;
  if (!brokerCompatible) {
    scoringError = "Goobi's LinkedIn background worker is out of date.";
    showNotice("Reload Goobi once in chrome://extensions, then refresh LinkedIn.");
  }
  await reconcileGate();
}

if (window.top === window && location.protocol === "https:" && location.hostname === "www.linkedin.com") {
  void boot();
}
