/**
 * Local-first model built from X's account-content CSV export.
 *
 * The raw rows never need to leave the popup and are never persisted. This module
 * returns aggregate, owner-scoped evidence only. Its recommendations are deliberately
 * sample-gated and described as correlations, not claims about X's ranking system.
 */

export type PostingPatternId =
  | "quantified-proof"
  | "community-invitation"
  | "earned-lesson"
  | "product-update"
  | "question-led"
  | "link-supported";

export type PostingLengthId = "0-100" | "101-180" | "181-260" | "261+";
export type PostingConfidence = "early" | "directional" | "repeat";

export interface PostingTotals {
  posts: number;
  impressions: number;
  engagements: number;
  follows: number;
  profileVisits: number;
  medianImpressions: number;
  followsPer1k: number;
  profileVisitsPer1k: number;
}

export interface PostingPatternStat extends PostingTotals {
  id: PostingPatternId | `original-length:${PostingLengthId}` | `reply-length:${PostingLengthId}`;
  label: string;
  confidence: PostingConfidence;
  shrunkFollowsPer1k: number;
  shrunkProfileVisitsPer1k: number;
  liftVsBaseline: number;
}

export interface PersonalPostingModel {
  version: 1;
  ownerHandle: string;
  importedAt: number;
  range: { from?: string; to?: string };
  rows: number;
  originals: PostingTotals;
  replies: PostingTotals;
  patterns: PostingPatternStat[];
  originalLengths: PostingPatternStat[];
  replyLengths: PostingPatternStat[];
  recommendations: {
    patterns: PostingPatternId[];
    originalLength?: PostingLengthId;
    replyLength?: PostingLengthId;
  };
}

interface AnalyticsRow {
  date?: string;
  text: string;
  kind: "original" | "reply";
  impressions: number;
  engagements: number;
  follows: number;
  profileVisits: number;
  length: number;
}

const REQUIRED_HEADERS = ["Date", "Post text", "Impressions", "Engagements", "New follows", "Profile visits"] as const;
const CONTENT_PATTERNS: { id: PostingPatternId; label: string; test: (text: string) => boolean }[] = [
  {
    id: "quantified-proof",
    label: "Quantified proof",
    test: (text) => /(?:\b(?:mrr|arr|revenue|sales|customers?|clients?|signups?|users?|followers?|downloads?|waitlist|conversion|growth|grew|saved|earned|made|sold)\b[^.!?\n]{0,55}\b\d[\d,.%$kmb]*|\b\d[\d,.%$kmb]*\s+(?:customers?|clients?|signups?|users?|followers?|downloads?|sales|conversions?)\b|(?:[$€£]\s?\d|\b\d[\d,.]*\s?(?:%|k|m|b)\b))/i.test(text),
  },
  {
    id: "community-invitation",
    label: "Community invitation",
    test: (text) => /\b(?:drop (?:what|your)|what are you building|what (?:are you|have you) working on|looking to connect|let'?s connect|connect with (?:people|builders|founders)|share (?:what|your)|show me what|who else is|reply with your)\b/i.test(text),
  },
  {
    id: "earned-lesson",
    label: "Earned lesson",
    test: (text) => /\b(?:i (?:learned|realized|noticed|was wrong)|we (?:learned|realized|noticed)|lesson|mistake|what worked|what didn'?t|after (?:building|shipping|launching|running)|the hard way)\b/i.test(text),
  },
  {
    id: "product-update",
    label: "Product update",
    test: (text) => /(?:\b(?:i|we) (?:just )?(?:launched|shipped|released|rolled out)\b|\b(?:my|our) [^.!?\n]{0,40}\bnow live\b|\b(?:new feature|product update)\b)/i.test(text),
  },
  {
    id: "question-led",
    label: "Question-led",
    test: (text) => /\?/.test(text),
  },
  {
    id: "link-supported",
    label: "Link-supported",
    test: (text) => /https?:\/\/\S+/i.test(text),
  },
];

function normalizeHandle(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function round(value: number, places = 2): number {
  const m = 10 ** places;
  return Math.round((Number.isFinite(value) ? value : 0) * m) / m;
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27|#(\d+)|#x([\da-f]+));/gi, (raw, dec?: string, hex?: string) => {
    if (dec) return String.fromCodePoint(Math.min(0x10ffff, Number(dec)));
    if (hex) return String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16)));
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ", "&#39;": "'", "&#x27;": "'" };
    return named[raw.toLowerCase()] ?? raw;
  });
}

/** RFC 4180-style parser: quoted commas, escaped quotes, and embedded newlines. */
export function parseAnalyticsCsv(input: string): string[][] {
  const text = input.replace(/^\ufeff/, "");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new Error("The CSV ends inside a quoted field. Export it from X again and retry.");
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function metric(value: string | undefined): number {
  const parsed = Number((value ?? "").replace(/[,_\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function visibleLength(text: string): number {
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  return [...withoutUrls].length;
}

function calendarDay(value: string): string | undefined {
  const exact = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(value);
  if (exact) return `${exact[1]}-${exact[2]}-${exact[3]}`;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const date = new Date(parsed), pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function lengthId(length: number): PostingLengthId {
  return length <= 100 ? "0-100" : length <= 180 ? "101-180" : length <= 260 ? "181-260" : "261+";
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function confidence(rows: AnalyticsRow[]): PostingConfidence {
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const follows = rows.reduce((sum, row) => sum + row.follows, 0);
  if (rows.length >= 12 && impressions >= 5_000 && follows >= 5) return "repeat";
  if (rows.length >= 5 && impressions >= 1_000) return "directional";
  return "early";
}

function totals(rows: AnalyticsRow[]): PostingTotals {
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const engagements = rows.reduce((sum, row) => sum + row.engagements, 0);
  const follows = rows.reduce((sum, row) => sum + row.follows, 0);
  const profileVisits = rows.reduce((sum, row) => sum + row.profileVisits, 0);
  return {
    posts: rows.length,
    impressions,
    engagements,
    follows,
    profileVisits,
    medianImpressions: round(median(rows.map((row) => row.impressions)), 1),
    followsPer1k: round(impressions ? follows * 1_000 / impressions : 0),
    profileVisitsPer1k: round(impressions ? profileVisits * 1_000 / impressions : 0),
  };
}

function stat(id: PostingPatternStat["id"], label: string, rows: AnalyticsRow[], baseline: PostingTotals, priorImpressions: number): PostingPatternStat {
  const measured = totals(rows);
  const baseFollowRate = baseline.impressions ? baseline.follows * 1_000 / baseline.impressions : 0;
  const baseProfileRate = baseline.impressions ? baseline.profileVisits * 1_000 / baseline.impressions : 0;
  const shrunkFollowsPer1k = (measured.follows + (baseFollowRate / 1_000) * priorImpressions) * 1_000 / Math.max(1, measured.impressions + priorImpressions);
  const shrunkProfileVisitsPer1k = (measured.profileVisits + (baseProfileRate / 1_000) * priorImpressions) * 1_000 / Math.max(1, measured.impressions + priorImpressions);
  return {
    id,
    label,
    ...measured,
    confidence: confidence(rows),
    shrunkFollowsPer1k: round(shrunkFollowsPer1k),
    shrunkProfileVisitsPer1k: round(shrunkProfileVisitsPer1k),
    liftVsBaseline: round(baseFollowRate > 0 ? shrunkFollowsPer1k / baseFollowRate : 1),
  };
}

function eligiblePattern(candidate: PostingPatternStat): boolean {
  return candidate.posts >= 5 && candidate.impressions >= 1_000 && candidate.confidence !== "early";
}

function performanceScore(candidate: PostingPatternStat, baseline: PostingTotals): number {
  const followBase = Math.max(0.2, baseline.followsPer1k);
  const profileBase = Math.max(1, baseline.profileVisitsPer1k);
  const reachBase = Math.max(1, baseline.medianImpressions);
  // A follow is the durable growth outcome. Profile pull and median reach help break ties,
  // but cannot crown a high-curiosity / low-conversion format over one that actually converts.
  return (candidate.shrunkFollowsPer1k / followBase) * 0.82
    + (candidate.shrunkProfileVisitsPer1k / profileBase) * 0.12
    + (Math.log1p(candidate.medianImpressions) / Math.log1p(reachBase)) * 0.06;
}

function pickLength(stats: PostingPatternStat[], baseline: PostingTotals, minPosts: number, minImpressions: number): PostingLengthId | undefined {
  const eligible = stats.filter((candidate) => candidate.posts >= minPosts && candidate.impressions >= minImpressions);
  eligible.sort((a, b) => performanceScore(b, baseline) - performanceScore(a, baseline));
  return eligible[0]?.id.split(":")[1] as PostingLengthId | undefined;
}

export function isPersonalPostingModel(value: unknown): value is PersonalPostingModel {
  const model = value as Partial<PersonalPostingModel> | null;
  const validTotals = (item: unknown): item is PostingTotals => {
    const totals = item as Partial<PostingTotals> | null;
    return !!totals && [totals.posts, totals.impressions, totals.engagements, totals.follows, totals.profileVisits, totals.medianImpressions, totals.followsPer1k, totals.profileVisitsPer1k]
      .every((metric) => typeof metric === "number" && Number.isFinite(metric) && metric >= 0);
  };
  const validStat = (item: unknown): item is PostingPatternStat => {
    if (!validTotals(item)) return false;
    const candidate = item as Partial<PostingPatternStat> | null;
    return !!candidate && typeof candidate.id === "string" && typeof candidate.label === "string"
      && (candidate.confidence === "early" || candidate.confidence === "directional" || candidate.confidence === "repeat")
      && typeof candidate.shrunkFollowsPer1k === "number" && Number.isFinite(candidate.shrunkFollowsPer1k)
      && typeof candidate.shrunkProfileVisitsPer1k === "number" && Number.isFinite(candidate.shrunkProfileVisitsPer1k)
      && typeof candidate.liftVsBaseline === "number" && Number.isFinite(candidate.liftVsBaseline);
  };
  return !!model && model.version === 1 && typeof model.ownerHandle === "string" && typeof model.importedAt === "number"
    && Number.isFinite(model.importedAt) && typeof model.rows === "number" && Number.isFinite(model.rows) && model.rows > 0
    && validTotals(model.originals) && validTotals(model.replies)
    && Array.isArray(model.patterns) && model.patterns.every(validStat)
    && Array.isArray(model.originalLengths) && model.originalLengths.every(validStat)
    && Array.isArray(model.replyLengths) && model.replyLengths.every(validStat)
    && !!model.recommendations && Array.isArray(model.recommendations.patterns);
}

export function postingModelIsActive(model: PersonalPostingModel | null | undefined, ownerHandle: string): boolean {
  return !!model && normalizeHandle(model.ownerHandle) === normalizeHandle(ownerHandle) && !!normalizeHandle(ownerHandle);
}

export function buildPersonalPostingModel(csv: string, ownerHandle: string, importedAt = Date.now()): PersonalPostingModel {
  const owner = normalizeHandle(ownerHandle);
  if (!owner) throw new Error("Set and save your X handle before importing analytics.");
  const grid = parseAnalyticsCsv(csv);
  if (grid.length < 2) throw new Error("This CSV has no analytics rows.");
  const headers = grid[0].map((header) => header.trim());
  const headerIndex = new Map(headers.map((header, index) => [header.toLowerCase(), index]));
  const missing = REQUIRED_HEADERS.filter((header) => !headerIndex.has(header.toLowerCase()));
  if (missing.length) throw new Error(`This does not look like X's account-content export. Missing: ${missing.join(", ")}.`);
  const cell = (row: string[], header: string) => row[headerIndex.get(header.toLowerCase()) ?? -1] ?? "";
  const rows: AnalyticsRow[] = [];
  for (const record of grid.slice(1, 20_001)) {
    const text = decodeEntities(cell(record, "Post text")).replace(/\u0000/g, "").trim();
    if (!text) continue;
    const rawDate = cell(record, "Date").trim();
    rows.push({
      date: rawDate ? calendarDay(rawDate) : undefined,
      text,
      kind: /^@[\p{L}\p{N}_]{1,30}\b/u.test(text) ? "reply" : "original",
      impressions: metric(cell(record, "Impressions")),
      engagements: metric(cell(record, "Engagements")),
      follows: metric(cell(record, "New follows")),
      profileVisits: metric(cell(record, "Profile visits")),
      length: visibleLength(text),
    });
  }
  if (!rows.length) throw new Error("No usable post rows were found in this CSV.");

  const originals = rows.filter((row) => row.kind === "original");
  const replies = rows.filter((row) => row.kind === "reply");
  if (!originals.length) throw new Error("No original posts were found. Import the account-content export, not a replies-only file.");
  const originalTotals = totals(originals), replyTotals = totals(replies);
  const patterns = CONTENT_PATTERNS.map((pattern) => stat(pattern.id, pattern.label, originals.filter((row) => pattern.test(row.text)), originalTotals, 5_000));
  const originalLengths = (["0-100", "101-180", "181-260", "261+"] as PostingLengthId[]).map((id) => stat(`original-length:${id}`, `${id} characters`, originals.filter((row) => lengthId(row.length) === id), originalTotals, 5_000));
  const replyLengths = (["0-100", "101-180", "181-260", "261+"] as PostingLengthId[]).map((id) => stat(`reply-length:${id}`, `${id} characters`, replies.filter((row) => lengthId(row.length) === id), replyTotals, 1_000));
  const recommendedPatterns = patterns
    .filter(eligiblePattern)
    .filter((candidate) => candidate.liftVsBaseline >= 0.9 || candidate.shrunkProfileVisitsPer1k >= originalTotals.profileVisitsPer1k)
    .sort((a, b) => performanceScore(b, originalTotals) - performanceScore(a, originalTotals))
    .slice(0, 2)
    .map((candidate) => candidate.id as PostingPatternId);
  const dates = rows.map((row) => row.date).filter((date): date is string => date != null).sort();
  return {
    version: 1,
    ownerHandle: owner,
    importedAt,
    range: { from: dates[0], to: dates[dates.length - 1] },
    rows: rows.length,
    originals: originalTotals,
    replies: replyTotals,
    patterns,
    originalLengths,
    replyLengths,
    recommendations: {
      patterns: recommendedPatterns,
      originalLength: pickLength(originalLengths, originalTotals, 8, 1_000),
      replyLength: replies.length >= 20 ? pickLength(replyLengths, replyTotals, 12, 500) : undefined,
    },
  };
}

function fmtRate(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

function patternById(model: PersonalPostingModel, id: PostingPatternId): PostingPatternStat | undefined {
  return model.patterns.find((pattern) => pattern.id === id);
}

/** Aggregate evidence for the Post Ideas prompt. Contains no post text. */
export function postingModelIdeasGuidance(model: PersonalPostingModel | null | undefined, ownerHandle: string): string {
  if (!model || !postingModelIsActive(model, ownerHandle)) return "";
  const patternLines = model.recommendations.patterns.map((id) => patternById(model, id)).filter((pattern): pattern is PostingPatternStat => !!pattern)
    .map((pattern) => `${pattern.label}: ${pattern.posts} original posts, ${fmtRate(pattern.followsPer1k)} follows and ${fmtRate(pattern.profileVisitsPer1k)} profile visits per 1K impressions (${pattern.confidence} signal)`);
  const length = model.recommendations.originalLength ? `Directionally favor ${model.recommendations.originalLength} visible characters for some drafts; do not pad or truncate a stronger idea to hit it.` : "No original-post length band cleared the sample gate.";
  return [
    `Historical personal posting model for @${model.ownerHandle}: ${model.originals.posts} original posts and ${model.replies.posts} replies from ${model.range.from || "an unknown date"} to ${model.range.to || "an unknown date"}. Correlation only, not a causal or algorithm claim.`,
    patternLines.length ? `The strongest sample-gated structures were ${patternLines.join("; ")}.` : "No content structure cleared the sample gate; keep the batch exploratory.",
    length,
    "Use these as priors for at most 3 of 5 ideas. Preserve topic diversity, never copy old wording, never invent proof, and let current source quality plus the user's SOUL.md win when the evidence conflicts.",
  ].join(" ");
}

/** Short delivery hint used only when Community Spark is selected. */
export function postingModelCommunityGuidance(model: PersonalPostingModel | null | undefined, ownerHandle: string): string {
  if (!model || !postingModelIsActive(model, ownerHandle) || !model.recommendations.replyLength) return "";
  const winner = model.replyLengths.find((stat) => stat.id === `reply-length:${model.recommendations.replyLength}`);
  if (!winner) return "";
  return `Historical personal reply signal: ${winner.label} was the strongest sample-gated response band across ${winner.posts} replies (${fmtRate(winner.followsPer1k)} follows per 1K impressions; ${winner.confidence}). Treat this as correlation only. Directionally stay in that range when the thought fits, but never pad, compress away the useful point, or claim the range causes reach.`;
}
