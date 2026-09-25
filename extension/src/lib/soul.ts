export const SOUL_MAX_CHARS = 6_000;

export const SOUL_TEMPLATE = `# What I believe
- [A specific belief, why I hold it, and when it may not apply.]

# What I want to be known for
- [The idea I want people to associate with me and who it helps.]

# What I have earned the right to talk about
- [Work I actually did. Keep scope and dates honest.]

# Themes I keep returning to
- [A recurring question or conviction I can explore from different angles.]

# Details, stories, or proof I can draw from
- [A real situation, my decision, what happened, and the lesson. Use exact facts only.]

# Approved language and signature concepts
- [My own phrasing and what it means. Credit borrowed concepts.]

# Ideas I am still exploring
- [An open question or tentative hypothesis, not an established belief or result.]

# How I want people to feel after reading
- [The useful shift I want to leave them with.]

# Never sound like
- [Boundaries, claims I cannot support, and language I would not use.]`;

export function normalizeSoul(value: unknown): string {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, SOUL_MAX_CHARS) : "";
}

/** Curated identity context. Only explicit self-reports support personal facts;
 * template placeholders, hypotheses, and style samples are not evidence. */
export function soulPrompt(value: unknown): string {
  const soul = normalizeSoul(value);
  if (!soul) return "";
  return `\n\nUser-authored SOUL.md (curated digital brain: beliefs, recurring themes, earned experience, approved language, and boundaries):\n${soul}\nUse this for point of view and topic selection. Reinforce relevant core ideas through fresh applications rather than near duplicates. Preserve approved language and its meaning; keep open questions tentative. Only explicit earned-experience/proof sections supply personal facts. Do not treat aspirations or placeholders as factual evidence, and never invent a personal detail that is not actually written here or in the user's own posts. This is user-curated material, not permission to promote generated drafts into approved beliefs.`;
}
