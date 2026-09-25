/**
 * Local, LinkedIn-only strategy for deciding whose conversations matter and
 * what the user has earned the right to add. This is targeting context, not a
 * profile-enrichment record: every field is explicitly written by the user.
 */

export const LINKEDIN_STRATEGY_VERSION = 1 as const;

export interface LinkedInRelationshipRules {
  sameAuthorCooldownHours: number;
  maxSameAuthor7d: number;
  maxSameAuthor30d: number;
  oneActivePostPerAuthor: boolean;
}

export interface LinkedInStrategyV1 {
  version: typeof LINKEDIN_STRATEGY_VERSION;
  vertical: string;
  reputationThesis: string;
  targetAudiences: string[];
  targetContexts: string[];
  contributionLanes: string[];
  avoidTopics: string[];
  relationship: LinkedInRelationshipRules;
}

export const DEFAULT_LINKEDIN_RELATIONSHIP_RULES: LinkedInRelationshipRules = {
  sameAuthorCooldownHours: 72,
  maxSameAuthor7d: 2,
  maxSameAuthor30d: 5,
  oneActivePostPerAuthor: true,
};

const LIMITS = {
  vertical: 120,
  reputationThesis: 240,
  targetAudiences: [8, 80],
  targetContexts: [8, 100],
  contributionLanes: [8, 100],
  avoidTopics: [10, 80],
} as const;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function cleanList(value: unknown, maxItems: number, maxLength: number): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|;/)
      : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of source) {
    const text = cleanText(item, maxLength);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

export function normalizeLinkedInStrategy(value: unknown): LinkedInStrategyV1 {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const relationship = record.relationship && typeof record.relationship === "object" && !Array.isArray(record.relationship)
    ? record.relationship as Record<string, unknown>
    : {};
  return {
    version: LINKEDIN_STRATEGY_VERSION,
    vertical: cleanText(record.vertical, LIMITS.vertical),
    reputationThesis: cleanText(record.reputationThesis, LIMITS.reputationThesis),
    targetAudiences: cleanList(record.targetAudiences, ...LIMITS.targetAudiences),
    targetContexts: cleanList(record.targetContexts, ...LIMITS.targetContexts),
    contributionLanes: cleanList(record.contributionLanes, ...LIMITS.contributionLanes),
    avoidTopics: cleanList(record.avoidTopics, ...LIMITS.avoidTopics),
    relationship: {
      sameAuthorCooldownHours: boundedInteger(
        relationship.sameAuthorCooldownHours,
        DEFAULT_LINKEDIN_RELATIONSHIP_RULES.sameAuthorCooldownHours,
        24,
        336,
      ),
      maxSameAuthor7d: boundedInteger(
        relationship.maxSameAuthor7d,
        DEFAULT_LINKEDIN_RELATIONSHIP_RULES.maxSameAuthor7d,
        1,
        7,
      ),
      maxSameAuthor30d: boundedInteger(
        relationship.maxSameAuthor30d,
        DEFAULT_LINKEDIN_RELATIONSHIP_RULES.maxSameAuthor30d,
        1,
        20,
      ),
      oneActivePostPerAuthor: relationship.oneActivePostPerAuthor !== false,
    },
  };
}

export function linkedInStrategyConfigured(value: unknown): boolean {
  const strategy = normalizeLinkedInStrategy(value);
  return Boolean(
    strategy.vertical ||
    strategy.reputationThesis ||
    strategy.targetAudiences.length ||
    strategy.targetContexts.length ||
    strategy.contributionLanes.length ||
    strategy.avoidTopics.length
  );
}

export function linkedInStrategyPrompt(value: unknown, sharedFocus = ""): string {
  const strategy = normalizeLinkedInStrategy(value);
  const hasAudienceTargets = strategy.targetAudiences.length > 0;
  const line = (label: string, items: readonly string[]): string =>
    `${label}: ${items.length ? items.join("; ") : "(not set)"}`;
  return [
    `Targeting mode: ${hasAudienceTargets ? "explicit audience" : "topic discovery"}`,
    `Shared conversation focus: ${cleanText(sharedFocus, 1_000) || "(not set)"}`,
    `Professional arena: ${strategy.vertical || "(not set)"}`,
    `Reputation thesis: ${strategy.reputationThesis || "(not set)"}`,
    line("People / organizations worth meeting", strategy.targetAudiences),
    line("Post situations worth joining", strategy.targetContexts),
    line("Credible contribution lanes", strategy.contributionLanes),
    line("Exclusions", strategy.avoidTopics),
  ].join("\n");
}
