export const SOUL_MAX_CHARS = 6_000;

export const SOUL_TEMPLATE = `# What I believe
-

# What I have earned the right to talk about
-

# Themes I keep returning to
-

# Details, stories, or proof I can draw from
-

# How I want people to feel after reading
-

# Never sound like
-`;

export function normalizeSoul(value: unknown): string {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, SOUL_MAX_CHARS) : "";
}

/** User-authored identity context. It guides point of view, never supplies unverified facts. */
export function soulPrompt(value: unknown): string {
  const soul = normalizeSoul(value);
  if (!soul) return "";
  return `\n\nUser-authored SOUL.md (beliefs, recurring themes, earned experience, and boundaries):\n${soul}\nUse this for point of view and topic selection. Do not treat aspirations or placeholders as factual evidence, and never invent a personal detail that is not actually written here or in the user's own posts.`;
}
