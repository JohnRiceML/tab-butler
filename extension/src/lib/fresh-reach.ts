/**
 * Pure selection policy for "Fresh reach" discovery.
 *
 * The content model decides whether the user can add something worthwhile. This module owns
 * only observed opportunity signals: post age, reply competition, public distribution, reachable
 * audience size, and author repetition. Popularity never makes an irrelevant post eligible, and Premium status is
 * deliberately absent: X describes verified-reply priority as a slight preference, not a reach
 * guarantee or a substitute for relevance, credibility, and safety.
 */

import { bandHiFor, MEGA_CAP } from "./targets";

export const FRESH_REACH_READY_MS = 30 * 60_000;
export const FRESH_REACH_MAX_AGE_MS = 2 * 60 * 60_000;
export const FRESH_REACH_MAX_REPLIES = 29;
export const FRESH_REACH_BREAKOUT_MAX_REPLIES = 49;
export const FRESH_REACH_MAJOR_MAX_REPLIES = 79;
export const FRESH_REACH_MAJOR_EARLY_MS = 20 * 60_000;
/** A cold manual hunt spends at most 24 author reads; together with one Latest and three Top
 * discovery reads that is 28 provider calls. Cache reuse and the governor/provider headers still
 * own the actual request rate and monthly boundary. */
export const FRESH_REACH_ACCOUNT_CHECKS = 24;
export const FRESH_REACH_ACCOUNT_CONCURRENCY = 6;
export const FRESH_REACH_TOP_LENSES = 3;
export const FRESH_REACH_CONTENT_CANDIDATES = 36;
/** Explicitly pinned massive accounts get bounded, rotating coverage without consuming the hunt. */
export const FRESH_REACH_WATCHLIST_MAX = 12;
export const FRESH_REACH_WATCHLIST_LANES = 4;
export const FRESH_REACH_SHORTLIST_MAX = 10;
export const FRESH_REACH_SHORTLIST_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const FRESH_REACH_EVIDENCE_HALF_LIFE_MS = 14 * 24 * 60 * 60_000;
export const FRESH_REACH_CONTENT_THRESHOLD = 0.68;

export type FreshReachOpportunityKind = "breakout" | "major-early" | "early-fit";

export interface FreshReachPostSignals {
  /** Likes + reposts + quotes. Replies stay separate because they are also competition. */
  engagements?: number;
  viewsPerMinute?: number;
  engagementsPerMinute?: number;
  viewRate?: number;
  engagementRate?: number;
  /** Age-normalized public distribution evidence, 0–1. Not a reach probability. */
  distributionScore: number;
}

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
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  views?: number;
  isReply?: boolean;
}

export interface FreshReachCandidate<T extends FreshReachPost = FreshReachPost> {
  post: T;
  opportunity: number;
  ageMinutes: number;
  sizeMultiple: number;
  kind: FreshReachOpportunityKind;
  signals: FreshReachPostSignals;
  state: "reply now" | "cooling";
}

/** A discovery-qualified account seed. Post content still has to pass the normal content-fit scorer. */
export interface FreshReachAccount {
  handle: string;
  followers?: number;
  engagementRate?: number;
  distributionScore?: number;
  peakViews?: number;
  peakEngagements?: number;
  tracked?: boolean;
  /** Explicit private-user pin: check this massive account directly instead of hoping Top finds it. */
  watchlisted?: boolean;
  activeInLatest?: boolean;
  lastReplyAt?: number;
  lastCheckedAt?: number;
  checks?: number;
  strongOpenings?: number;
  /** This user's settled reply-view keep-list. These are outcome facts, not target-post fame. */
  shortlisted?: boolean;
  replyViewOutcomes?: number;
  replyViewScore?: number;
  bestReplyViews?: number;
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

/** Minimal shape from the persisted reply ledger needed to derive the massive-account keep-list. */
export interface FreshReachShortlistRecord {
  at: number;
  author?: string;
  source?: string;
  followers?: number;
  confirmation?: "rapidapi" | "manual";
  freshReach?: { kind?: FreshReachOpportunityKind; sizeMultiple?: number; expiresAt?: number };
  outcome?: {
    at?: number;
    views?: number;
    likes?: number;
    replies?: number;
    reposts?: number;
    tweetId?: string;
    frozen?: boolean;
  };
}

/** Historical public distribution is useful account-discovery evidence, not a permanent trait. */
export function decayFreshReachEvidence(value: number | undefined, observedAt: number | undefined, now: number): number | undefined {
  if (value == null) return undefined;
  if (!observedAt || observedAt >= now) return clamp(value);
  return clamp(value * Math.pow(0.5, (now - observedAt) / FRESH_REACH_EVIDENCE_HALF_LIFE_MS));
}

export interface FreshReachShortlistAccount {
  handle: string;
  followers: number;
  outcomes: number;
  averageReplyViews: number;
  bestReplyViews: number;
  totalReplyViews: number;
  /** Bayesian-shrunk reply views used only to order the keep-list and account checks. */
  replyViewScore: number;
  lastOutcomeAt: number;
  confidence: "early signal" | "repeat signal";
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
const cleanMetric = (n: number | undefined): number | undefined => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;

/** One shared definition for the widened major-account lane and its measured keep-list. */
export function isMassiveFreshReachAccount(followers: number | undefined, myFollowers: number, observedMultiple?: number): boolean {
  if (!myFollowers) return false;
  const multiple = observedMultiple ?? ((followers ?? 0) / myFollowers);
  return (followers ?? 0) > MEGA_CAP || multiple > Math.max(2.01, bandHiFor(myFollowers));
}

/**
 * Keep at most ten massive accounts where this user's own Fresh Reach replies produced settled,
 * API-matched view evidence. One provisional snapshot cannot silently become a "winner": outcomes
 * must be frozen, attributable to an actual reply tweet, and clear a modest measured floor. Ordering
 * uses a two-outcome prior so one lucky spike does not permanently outrank repeat performance.
 */
export function freshReachShortlist(
  records: readonly FreshReachShortlistRecord[],
  myFollowers: number,
  max = FRESH_REACH_SHORTLIST_MAX,
  now = Date.now(),
): FreshReachShortlistAccount[] {
  if (!myFollowers || max <= 0) return [];
  const eligible = records.filter((record) => {
    const handle = norm(record.author ?? "");
    const outcome = record.outcome;
    const massive = record.freshReach?.kind === "major-early"
      || isMassiveFreshReachAccount(record.followers, myFollowers, record.freshReach?.sizeMultiple);
    return record.source === "fresh-reach" && /^[a-z0-9_]{1,15}$/.test(handle) && massive
      && (record.freshReach?.expiresAt == null || record.at <= record.freshReach.expiresAt)
      && record.at <= now && now - record.at <= FRESH_REACH_SHORTLIST_RETENTION_MS
      && outcome?.frozen === true && (record.confirmation === "rapidapi" || !!outcome.tweetId)
      && cleanMetric(outcome.views) != null;
  });
  if (!eligible.length) return [];

  const allViews = eligible.map((record) => cleanMetric(record.outcome?.views) ?? 0).sort((a, b) => a - b);
  const prior = allViews[Math.floor((allViews.length - 1) / 2)] ?? 0;
  const keepFloor = Math.max(100, prior);
  const grouped = new Map<string, { followers: number; views: number[]; lastOutcomeAt: number }>();
  for (const record of eligible) {
    const handle = norm(record.author ?? "");
    const group = grouped.get(handle) ?? { followers: record.followers ?? 0, views: [], lastOutcomeAt: 0 };
    group.followers = Math.max(group.followers, record.followers ?? 0);
    group.views.push(cleanMetric(record.outcome?.views) ?? 0);
    group.lastOutcomeAt = Math.max(group.lastOutcomeAt, record.outcome?.at ?? record.at);
    grouped.set(handle, group);
  }

  const out: FreshReachShortlistAccount[] = [];
  for (const [handle, group] of grouped) {
    if (!group.followers) continue; // direct account monitoring needs a real size snapshot
    const outcomes = group.views.length;
    const totalReplyViews = group.views.reduce((sum, views) => sum + views, 0);
    const averageReplyViews = totalReplyViews / outcomes;
    const bestReplyViews = Math.max(...group.views);
    // A single reply needs to clear the global/fixed view floor; repeat evidence can qualify when
    // its average is close to that floor. This prevents a list full of measured-but-flat accounts.
    if (bestReplyViews < keepFloor && (outcomes < 2 || averageReplyViews < keepFloor * 0.75)) continue;
    const shrunk = (2 * prior + totalReplyViews) / (2 + outcomes);
    const confidenceBoost = 0.88 + 0.04 * Math.min(3, outcomes);
    out.push({
      handle,
      followers: group.followers,
      outcomes,
      averageReplyViews: Math.round(averageReplyViews),
      bestReplyViews,
      totalReplyViews,
      replyViewScore: Math.round(shrunk * confidenceBoost),
      lastOutcomeAt: group.lastOutcomeAt,
      confidence: outcomes >= 2 ? "repeat signal" : "early signal",
    });
  }
  return out.sort((a, b) => b.replyViewScore - a.replyViewScore
    || b.outcomes - a.outcomes
    || b.bestReplyViews - a.bestReplyViews
    || a.handle.localeCompare(b.handle)).slice(0, Math.max(0, max));
}

/** Log-scaled evidence between an honest floor and an exceptional observed value. */
function logProgress(value: number | undefined, floor: number, exceptional: number): number {
  if (value == null || value <= floor || exceptional <= floor) return 0;
  return clamp(Math.log(value / floor) / Math.log(exceptional / floor));
}

/**
 * Build a first-snapshot distribution signal from public post metrics. The two normalized views
 * (absolute pace and share of the author's audience) keep this useful for both practical and huge
 * accounts. Missing metrics remain neutral; they are never fabricated as zero-performance proof.
 */
export function freshReachPostSignals(post: FreshReachPost, now: number): FreshReachPostSignals {
  const followers = cleanMetric(post.followers);
  const views = cleanMetric(post.views);
  const likes = cleanMetric(post.likes);
  const reposts = cleanMetric(post.reposts);
  const quotes = cleanMetric(post.quotes);
  const hasEngagement = likes != null || reposts != null || quotes != null;
  const engagements = hasEngagement ? (likes ?? 0) + (reposts ?? 0) + (quotes ?? 0) : undefined;
  const ageMinutes = post.postedAt == null ? undefined : Math.max(2, Math.max(0, now - post.postedAt) / 60_000);
  const viewsPerMinute = views != null && ageMinutes != null ? views / ageMinutes : undefined;
  const engagementsPerMinute = engagements != null && ageMinutes != null ? engagements / ageMinutes : undefined;
  const viewRate = views != null && followers ? views / followers : undefined;
  const engagementRate = engagements != null && followers ? engagements / followers : undefined;

  const viewScores = views == null ? [] : [
    logProgress(viewsPerMinute, 25, 1_000),
    logProgress(viewRate, 0.02, 0.4),
  ];
  const engagementScores = engagements == null ? [] : [
    logProgress(engagementsPerMinute, 0.5, 25),
    logProgress(engagementRate, 0.002, 0.04),
  ];
  const viewScore = viewScores.length ? 0.58 * viewScores[0] + 0.42 * viewScores[1] : undefined;
  const engagementScore = engagementScores.length ? 0.62 * engagementScores[0] + 0.38 * engagementScores[1] : undefined;
  const distributionScore = viewScore != null && engagementScore != null
    ? 0.62 * viewScore + 0.38 * engagementScore
    : (viewScore ?? engagementScore ?? 0);
  return { engagements, viewsPerMinute, engagementsPerMinute, viewRate, engagementRate, distributionScore: clamp(distributionScore) };
}

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
  if (replies <= 40) return 0.5;
  return 0.3;
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
 * Observed distribution, audience fit, current niche activity, a user's explicit tracking choice,
 * prior opening yield, reply diversity, and recently-paid query cost all matter. This only
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
    const massive = isMassiveFreshReachAccount(account.followers, myFollowers, sizeMultiple);
    const audience = massive
      ? 0.72 // worth one exploration lane, but never beats practical accounts merely by size
      : clamp(Math.log2(Math.max(2, sizeMultiple) / 2) / Math.log2(ceiling / 2));
    // Heavy-hitter search stores a mean Top-post rate. Unknown stays neutral rather than bad.
    const engagement = account.engagementRate == null
      ? 0.4
      : clamp((Math.log10(Math.max(0.0001, account.engagementRate)) + 4) / 2);
    const distribution = account.distributionScore == null
      ? (account.peakViews == null ? 0.4 : logProgress(account.peakViews, 5_000, 1_000_000))
      : clamp(account.distributionScore);
    const yieldRate = account.checks
      ? clamp((account.strongOpenings ?? 0) / Math.max(1, account.checks) * 2)
      : 0.4;
    const measured = account.measuredValue == null ? 0.4 : clamp((account.measuredValue - 0.9) / 0.25);
    const replyViews = account.shortlisted
      ? 0.55 + 0.45 * logProgress(account.replyViewScore, 100, 50_000)
      : 0;
    const base = 0.22 * audience
      + 0.12 * engagement
      + 0.23 * distribution
      + 0.13 * yieldRate
      + 0.07 * measured
      + 0.1 * (account.activeInLatest ? 1 : 0)
      + 0.08 * (account.tracked ? 1 : 0)
      + 0.05 * audienceFit
      + 0.18 * replyViews;
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
  const replyReservationEligible = (candidate: FreshReachAccountCandidate<T>): boolean =>
    !candidate.account.lastReplyAt || now - candidate.account.lastReplyAt >= 24 * 60 * 60_000;
  const addFirst = (list: FreshReachAccountCandidate<T>[], predicate: (candidate: FreshReachAccountCandidate<T>) => boolean): void => {
    const match = list.find((candidate) => predicate(candidate) && !selected.some((picked) => norm(picked.account.handle) === norm(candidate.account.handle)));
    if (match && selected.length < Math.max(0, max)) selected.push(match);
  };
  // Reserve coverage lanes when the pool supports them. Explicit massive-account pins receive up
  // to four ROTATING lanes; recent checks fall into `cached`, so successive hunts naturally move
  // through a full 12-account watchlist instead of repeatedly paying for the same famous accounts.
  // Measured winners and fresh massive exploration remain separate so user pins cannot close the
  // discovery loop around a fixed celebrity list. Post content still faces the strict quality gate.
  for (const candidate of due) {
    if (selected.filter((picked) => picked.account.watchlisted).length >= Math.min(FRESH_REACH_WATCHLIST_LANES, Math.max(0, max))) break;
    if (candidate.account.watchlisted && replyReservationEligible(candidate)
      && !selected.some((picked) => norm(picked.account.handle) === norm(candidate.account.handle))) selected.push(candidate);
  }
  addFirst(due, (candidate) => candidate.massive && !!candidate.account.shortlisted && replyReservationEligible(candidate));
  // Fame alone is not evidence that a paid direct check is worth displacing a stronger practical
  // account. Reserve exploration only for observed distribution/yield; a flat massive account can
  // still enter later on spare capacity through the normal priority fill.
  addFirst(due, (candidate) => candidate.massive && !candidate.account.shortlisted && !candidate.account.watchlisted
    && replyReservationEligible(candidate)
    && ((candidate.account.distributionScore ?? 0) >= 0.58 || (candidate.account.strongOpenings ?? 0) > 0
      || (!!candidate.account.activeInLatest && ((candidate.account.peakViews ?? 0) >= 5_000 || (candidate.account.peakEngagements ?? 0) >= 100))));
  // The remaining signals already contribute to `priority`; reserving each one separately can let
  // weak categorical rows consume most of a small check budget. Fill by score, preferring authors
  // the user has not replied to in the last day, then use repeats only if capacity would go unused.
  for (const candidate of due) if (replyReservationEligible(candidate) && selected.length < Math.max(0, max) && !selected.some((picked) => norm(picked.account.handle) === norm(candidate.account.handle))) selected.push(candidate);
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
  if (post.replies == null) return null;

  const sizeMultiple = (post.followers ?? 0) / myFollowers;
  const signals = freshReachPostSignals(post, now);
  const massive = isMassiveFreshReachAccount(post.followers, myFollowers, sizeMultiple);
  const observedBreakout = signals.distributionScore >= 0.58
    && ((post.views ?? 0) >= 1_000 || (signals.engagements ?? 0) >= 50);
  const majorEarly = massive && ageMs <= FRESH_REACH_MAJOR_EARLY_MS
    && post.replies <= FRESH_REACH_MAJOR_MAX_REPLIES
    // Above the ordinary room limit, require live distribution—not fame alone—to widen the lane.
    && (post.replies <= FRESH_REACH_MAX_REPLIES || (post.views ?? 0) >= 5_000 || (signals.engagements ?? 0) >= 100);
  const breakout = observedBreakout && ageMs <= 90 * 60_000 && post.replies <= FRESH_REACH_BREAKOUT_MAX_REPLIES;
  if (!majorEarly && !breakout && post.replies > FRESH_REACH_MAX_REPLIES) return null;

  const kind: FreshReachOpportunityKind = majorEarly ? "major-early" : breakout ? "breakout" : "early-fit";
  const timing = freshness(Math.max(0, ageMs));
  const room = threadRoom(post.replies);
  const opportunity = clamp((kind === "breakout"
    ? 0.38 * timing + 0.24 * room + 0.1 * reach + 0.28 * signals.distributionScore
    : kind === "major-early"
      ? 0.48 * timing + 0.3 * room + 0.07 * reach + 0.15 * signals.distributionScore
      : 0.52 * timing + 0.32 * room + 0.16 * reach)
    * repeatFactor(lastAuthorReplyAt, now));

  return {
    post,
    opportunity,
    ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
    sizeMultiple,
    kind,
    signals,
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
  perAuthor = 1,
): FreshReachCandidate<T>[] {
  const byAuthor = new Map<string, FreshReachCandidate<T>[]>();
  for (const post of posts) {
    const handle = norm(post.author);
    const candidate = freshReachCandidate(post, myFollowers, now, lastReplyByAuthor[handle]);
    if (!candidate) continue;
    const author = [...(byAuthor.get(handle) ?? []), candidate]
      .sort((a, b) => b.opportunity - a.opportunity || (b.post.postedAt ?? 0) - (a.post.postedAt ?? 0))
      .slice(0, Math.max(1, perAuthor));
    byAuthor.set(handle, author);
  }
  return [...byAuthor.values()].flat()
    .sort((a, b) => b.opportunity - a.opportunity
      || (b.post.postedAt ?? 0) - (a.post.postedAt ?? 0)
      || a.post.author.localeCompare(b.post.author))
    .slice(0, Math.max(0, max));
}
