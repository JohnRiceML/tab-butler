/** Shapes shared with the proxy. Keep in sync with proxy/src/lib/schemas.ts. */

export interface TabInput {
  id: number;
  title: string;
  url: string;
  lastAccessedMinutes?: number;
}

export interface GroupSuggestion {
  name: string;
  color: chrome.tabGroups.ColorEnum;
  tabIds: number[];
  reason: string;
}

export interface ClassifyResult {
  groups: GroupSuggestion[];
}

export type RecommendationKind =
  | "archive"
  | "close_duplicates"
  | "close_localhost_tab"
  | "bookmark"
  | "regroup";

export interface Recommendation {
  id: string;
  kind: RecommendationKind;
  title: string;
  detail: string;
  tabIds: number[];
  confidence: "low" | "medium" | "high";
}

export interface AdviceResult {
  summary: string;
  recommendations: Recommendation[];
}

/** What we persist when a tab is auto-archived — enough to fully restore it. */
export interface ArchivedTab {
  url: string;
  title: string;
  favIconUrl?: string;
  archivedAt: number;
  tags?: string[];
}

/** Messages between the popup and the service worker. */
export type Message =
  | { type: "GROUP_NOW" }
  | { type: "ADVISE_NOW" }
  | { type: "ARCHIVE_IDLE_NOW" }
  | { type: "UNDO_LAST" }
  | { type: "APPLY_REC"; kind: RecommendationKind; tabIds: number[] }
  | { type: "SCORE_POSTS"; posts: { i: number; author: string; text: string; meta?: string }[] }
  | { type: "DRAFT_REPLY"; author: string; text: string; context?: string; angle?: string; product?: string; images?: string[] }
  | { type: "GET_STATE" };
