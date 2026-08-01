/**
 * Pure selection policy for "Fresh reach" discovery.
 *
 * The content model decides whether the user can add something worthwhile. This module owns
 * only observed opportunity signals: post age, reply competition, reachable audience size, and
 * author repetition. Popularity never makes an irrelevant post eligible, and Premium status is
 * deliberately absent: X describes verified-reply priority as a slight preference, not a reach
 * guarantee or a substitute for relevance, credibility, and safety.
 */

import { bandHiFor, MEGA_CAP } from "./targets";

export const FRESH_REACH_READY_MS = 30 * 60_000;
export const FRESH_REACH_MAX_AGE_MS = 2 * 60 * 60_000;
export const FRESH_REACH_MAX_REPLIES = 29;
export const FRESH_REACH_ACCOUNT_CHECKS = 5;
export const FRESH_REACH_CONTENT_THRESHOLD = 0.68;

export interface FreshReachContentScore {
  score: number;
  anchor?: string;
  replyBrief?: string;
  risk?: string;
}

export interface FreshReachOpeningInput {
  contentFit: number;
  observedOpportunity: number;
  /** Optional measured post velocity, normalized 0–1. It is only a small tie-breaker. */
  momentum?: number;
}

export type FreshReachOpeningBand = "exceptional" | "strong" | "qualified";

export interface FreshReachPost {
  id: string;
  author: string;
  text: string;
  postedAt?: number;
  followers?: number;
  replies?: number;
  isReply?: boolean;
}

export interface FreshReachCandidate<T extends FreshReachPost = FreshReachPost> {
  post: T;
  opportunity: number;
  ageMinutes: number;
  sizeMultiple: number;
  state: "reply now" | "cooling";
}

/** A discovery-qualified account seed. Post content still has to pass the normal content-fit scorer. */
export interface FreshReachAccount {
  handle: string;
  followers?: number;
  engagementRate?: number;
  tracked?: boolean;
  activeInLatest?: boolean;
  lastReplyAt?: number;
  lastCheckedAt?: number;
  checks?: number;
  strongOpenings?: number;
  discoveredAt?: number;
  /** Optional measured outcome multiplier from the user's own settled replies (roughly 0.9–1.15). */
  measuredValue?: number;
}

export interface FreshReachAccountCandidate<T extends FreshReachAccount = FreshReachAccount> {
  account: T;
  priority: number;
  sizeMultiple: number;
  massive: boolean;
}

/**
 * Keep the large-account hunt subordinate to reply quality. A model score by itself is not enough:
 * Fresh reach must name the exact post detail to engage, propose a useful contribution, and find no
 * generic/promotional/context risk. This pure gate is intentionally shared by search and Targets.
 */
export function freshReachContentEligible(score: FreshReachContentScore): boolean {
  return score.score >= FRESH_REACH_CONTENT_THRESHOLD
    && score.risk === "none"
    && Boolean(score.anchor?.trim() && score.replyBrief?.trim());
}

/**
 * One inspectable answer to “where is the best place to try right now?” Content fit is
 * multiplicative, so a large/fresh account can never rescue a weak contribution. Observed public
 * velocity can add at most 12%, matching the rest of the app's bounded momentum policy. The result
 * is an opportunity index for comparing current candidates, never an impression probability.
 */
export function freshReachOpeningScore(input: FreshReachOpeningInput): number {
  const base = clamp(input.contentFit) * clamp(input.observedOpportunity);
  return clamp(base * (1 + 0.12 * clamp(input.momentum ?? 0)));
}

export function freshReachOpeningBand(score: number): FreshReachOpeningBand {
  const value = clamp(score);
  if (value >= 0.74) return "exceptional";
  if (value >= 0.58) return "strong";
  return "qualified";
}

const norm = (handle: string): string => handle.replace(/^@+/, "").trim().toLowerCase();
const clamp = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

function freshness(ageMs: number): number {
  const mins = ageMs / 60_000;
  if (mins <= 5) return 1;
  if (mins <= 15) return 0.96;
  if (mins <= 30) return 0.86;
  if (mins <= 60) return 0.62;
  return 0.34;
}

function threadRoom(replies: number | undefined): number {
  if (replies == null) return 0.62;
  if (replies <= 5) return 1;
  if (replies <= 20) return 0.72;
  return 0.42;
}

function repeatFactor(lastAt: number | undefined, now: number): number {
  if (!lastAt) return 1;
  const age = Math.max(0, now - lastAt);
  if (age < 24 * 60 * 60_000) return 0.6;
  if (age < 72 * 60 * 60_000) return 0.8;
  return 1;
}

function checkDue(lastAt: number | undefined, now: number): number {
  if (!lastAt) return 1;
  const age = Math.max(0, now - lastAt);
  if (age < 12 * 60_000) return 0;
  if (age < 60 * 60_000) return 0.45;
  return 1;
}

/**
 * Audience opportunity for Fresh Reach. Unlike the narrower Targets workspace, this deliberately
 * permits massive accounts: a just-posted, nearly empty thread can be a real opening. The score
 * plateaus in the practical band and then declines with audience gap, so a celebrity account is an
 * exploration candidate rather than an automatic winner. Returns null only when the account is not
 * actually larger than the user or the evidence is missing.
 */
export function freshReachAudienceFit(followers: number | undefined, myFollowers: number): number | null {
  if (!followers || !myFollowers) return null;
  const multiple = followers / myFollowers;
  if (!Number.isFinite(multiple) || multiple < 2) return null;
  const ceiling = Math.max(2.01, bandHiFor(myFollowers));
  if (multiple < 4) return 0.75 + 0.25 * clamp((multiple - 2) / 2);
  if (multiple <= 12) return 1;
  if (multiple <= ceiling) return 0.8 + 0.2 * clamp((ceiling - multiple) / Math.max(1, ceiling - 12));
  const gap = multiple / ceiling;
  return Math.max(0.38, 0.72 - 0.16 * Math.log2(Math.max(1, gap)));
}

/**
 * Pick a small, diverse set of larger accounts from the saved radar to inspect directly.
 * Size is the largest sourcing signal, but observed engagement, current niche activity, a user's
 * explicit tracking choice, reply diversity, and recently-paid query cost all matter. This only
 * chooses whose newest posts to fetch; it never makes a post reply-worthy by itself.
 */
export function pickFreshReachAccounts<T extends FreshReachAccount>(
  accounts: readonly T[],
  myFollowers: number,
  now: number,
  max = FRESH_REACH_ACCOUNT_CHECKS,
): FreshReachAccountCandidate<T>[] {
  const byHandle = new Map<string, FreshReachAccountCandidate<T>>();
  for (const account of accounts) {
    const handle = norm(account.handle);
    const audienceFit = freshReachAudienceFit(account.followers, myFollowers);
    if (!/^[a-z0-9_]{1,15}$/.test(handle) || audienceFit == null) continue;
    const sizeMultiple = (account.followers ?? 0) / myFollowers;
    const ceiling = Math.max(2.01, bandHiFor(myFollowers));
    const massive = sizeMultiple > ceiling || (account.followers ?? 0) > MEGA_CAP;
    const audience = massive
      ? 0.72 // worth one exploration lane, but never beats practical accounts merely by size
      : clamp(Math.log2(Math.max(2, sizeMultiple) / 2) / Math.log2(ceiling / 2));
    // Heavy-hitter search stores a mean Top-post rate. Unknown stays neutral rather than bad.
    const engagement = account.engagementRate == null
      ? 0.4
      : clamp((Math.log10(Math.max(0.0001, account.engagementRate)) + 4) / 2);
    const yieldRate = account.checks
      ? clamp((account.strongOpenings ?? 0) / Math.max(1, account.checks) * 2)
      : 0.4;
    const measured = account.measuredValue == null ? 0.4 : clamp((account.measuredValue - 0.9) / 0.25);
    const base = 0.3 * audience
      + 0.2 * engagement
      + 0.13 * yieldRate
      + 0.08 * measured
      + 0.14 * (account.activeInLatest ? 1 : 0)
      + 0.1 * (account.tracked ? 1 : 0)
      + 0.05 * audienceFit;
    // A just-paid query cannot reveal anything newer until its 12-minute cache expires. Prefer a
    // different qualified account when one exists, without making a small pool go empty.
    const dueFactor = 0.55 + 0.45 * checkDue(account.lastCheckedAt, now);
    const candidate = {
      account,
      priority: clamp(base * dueFactor * repeatFactor(account.lastReplyAt, now)),
      sizeMultiple,
      massive,
    };
    const previous = byHandle.get(handle);
    if (!previous || candidate.priority > previous.priority) byHandle.set(handle, candidate);
  }
  const ranked = [...byHandle.values()].sort((a, b) => b.priority - a.priority
    || b.sizeMultiple - a.sizeMultiple
    || a.account.handle.localeCompare(b.account.handle));
  // Do not repay a query while its 12-minute cache is live when enough due accounts exist. A
  // small pool can still fall back to cached accounts, so the button remains useful and free.
  const due = ranked.filter((candidate) => !candidate.account.lastCheckedAt || now - candidate.account.lastCheckedAt >= 12 * 60_000);
  const cached = ranked.filter((candidate) => candidate.account.lastCheckedAt && now - candidate.account.lastCheckedAt < 12 * 60_000);
  const selected: FreshReachAccountCandidate<T>[] = [];
  const addFirst = (list: FreshReachAccountCandidate<T>[], predicate: (candidate: FreshReachAccountCandidate<T>) => boolean): void => {
    const match = list.find((candidate) => predicate(candidate) && !selected.some((picked) => norm(picked.account.handle) === norm(candidate.account.handle)));
    if (match && selected.length < Math.max(0, max)) selected.push(match);
  };
  // Reserve coverage lanes when the pool supports them. This is what makes a growing saved radar
  // useful: explicit targets, proven accounts, currently active authors, and one massive account
  // all get a chance instead of five near-identical size-ranked checks.
  addFirst(due, (candidate) => !!candidate.account.tracked);
  addFirst(due, (candidate) => (candidate.account.strongOpenings ?? 0) > 0);
  addFirst(due, (candidate) => !!candidate.account.activeInLatest);
  addFirst(due, (candidate) => candidate.massive);
  for (const candidate of due) if (selected.length < Math.max(0, max) && !selected.some((picked) => norm(picked.account.handle) === norm(candidate.account.handle))) selected.push(candidate);
  for (const candidate of cached) if (selected.length < Math.max(0, max) && !selected.some((picked) => norm(picked.account.handle) === norm(candidate.account.handle))) selected.push(candidate);
  return selected;
}

/** Score observed timing/reach signals only. Returns null when the post is not honestly eligible. */
export function freshReachCandidate<T extends FreshReachPost>(
  post: T,
  myFollowers: number,
  now: number,
  lastAuthorReplyAt?: number,
): FreshReachCandidate<T> | null {
  if (!post.id || !post.author || !post.text || post.isReply || !post.postedAt || !myFollowers) return null;
  const ageMs = now - post.postedAt;
  if (ageMs < -5 * 60_000 || ageMs > FRESH_REACH_MAX_AGE_MS) return null;
  const reach = freshReachAudienceFit(post.followers, myFollowers);
  if (reach == null) return null;
  // This strict mode promises a thread with observed room. Unknown cannot honestly be called
  // uncrowded; ordinary Find spots can still surface it with limited-evidence labeling.
  if (post.replies == null || post.replies > FRESH_REACH_MAX_REPLIES) return null;

  const sizeMultiple = (post.followers ?? 0) / myFollowers;
  const opportunity = clamp(
    (0.52 * freshness(Math.max(0, ageMs)) + 0.32 * threadRoom(post.replies) + 0.16 * reach)
      * repeatFactor(lastAuthorReplyAt, now),
  );

  return {
    post,
    opportunity,
    ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
    sizeMultiple,
    state: ageMs <= FRESH_REACH_READY_MS ? "reply now" : "cooling",
  };
}

/**
 * Rank a mixed Latest-search result into an account-diverse fresh-reach batch.
 * At most one post per author survives so a prolific account cannot crowd out the queue.
 */
export function pickFreshReachCandidates<T extends FreshReachPost>(
  posts: readonly T[],
  myFollowers: number,
  now: number,
  lastReplyByAuthor: Record<string, number> = {},
  max = 12,
): FreshReachCandidate<T>[] {
  const byAuthor = new Map<string, FreshReachCandidate<T>>();
  for (const post of posts) {
    const handle = norm(post.author);
    const candidate = freshReachCandidate(post, myFollowers, now, lastReplyByAuthor[handle]);
    if (!candidate) continue;
    const prev = byAuthor.get(handle);
    if (!prev || candidate.opportunity > prev.opportunity
      || (candidate.opportunity === prev.opportunity && (post.postedAt ?? 0) > (prev.post.postedAt ?? 0))) {
      byAuthor.set(handle, candidate);
    }
  }
  return [...byAuthor.values()]
    .sort((a, b) => b.opportunity - a.opportunity
      || (b.post.postedAt ?? 0) - (a.post.postedAt ?? 0)
      || a.post.author.localeCompare(b.post.author))
    .slice(0, Math.max(0, max));
}
