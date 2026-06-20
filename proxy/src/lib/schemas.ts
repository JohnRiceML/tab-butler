import { z } from "zod";

/**
 * Chrome tab-group colors — the model must pick from this exact set so the
 * extension can apply the result to `chrome.tabGroups.update` with no mapping.
 */
export const TAB_GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;

export const TabInput = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  /** Minutes since the tab was last active. Drives the "stale" signal. */
  lastAccessedMinutes: z.number().optional(),
});
export type TabInput = z.infer<typeof TabInput>;

export const LocalhostServer = z.object({
  port: z.number(),
  title: z.string().optional(),
  idleMinutes: z.number().optional(),
});
export type LocalhostServer = z.infer<typeof LocalhostServer>;

/* ---------- /classify ---------- */

export const ClassifyRequest = z.object({
  tabs: z.array(TabInput),
});
export type ClassifyRequest = z.infer<typeof ClassifyRequest>;

export const GroupSuggestion = z.object({
  name: z
    .string()
    .describe(
      "Short, human, specific group name. Prefer 'Lenovo ThinkPad shopping' over 'Shopping'.",
    ),
  color: z.enum(TAB_GROUP_COLORS),
  tabIds: z.array(z.number()),
  reason: z.string().describe("One short phrase: why these tabs belong together."),
});

export const ClassifyResult = z.object({
  groups: z.array(GroupSuggestion),
});
export type ClassifyResult = z.infer<typeof ClassifyResult>;

/* ---------- /advise ---------- */

export const AdviseRequest = z.object({
  tabs: z.array(TabInput),
  localhost: z.array(LocalhostServer).optional(),
  /** 0–100. Optional context so the advisor can prioritize when memory is tight. */
  systemMemoryUsedPct: z.number().optional(),
});
export type AdviseRequest = z.infer<typeof AdviseRequest>;

export const Recommendation = z.object({
  id: z.string(),
  kind: z.enum([
    "archive",
    "close_duplicates",
    "close_localhost_tab",
    "bookmark",
    "regroup",
  ]),
  title: z.string().describe("Imperative, e.g. 'Archive 9 stale tabs'."),
  detail: z.string().describe("One line of justification the user can trust."),
  /** Tabs (or, for stop_localhost, the tab hosting the dev server) the action applies to. */
  tabIds: z.array(z.number()),
  confidence: z.enum(["low", "medium", "high"]),
});

export const AdviceResult = z.object({
  summary: z.string().describe("One sentence: what you found, plain language."),
  recommendations: z.array(Recommendation),
});
export type AdviceResult = z.infer<typeof AdviceResult>;
