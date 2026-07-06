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
  | { type: "DRAFT_REPLY"; author: string; text: string; context?: string; angle?: string; product?: string; steer?: string; reason?: string; category?: string; authorLine?: string }
  | { type: "GET_FAVICONS"; hosts: string[] }
  | { type: "TWTTR_GET"; path: string; query?: Record<string, string>; intent?: boolean }
  | { type: "GET_TWTTR_METER" }
  | { type: "POST_IDEAS"; posts: { author: string; text: string; likes?: number; reposts?: number; followers?: number; shape?: string }[]; ownPosts?: { text: string; likes?: number; reposts?: number }[]; followers?: number; shapeLine?: string }
  | { type: "POST_IDEA_REWRITE"; text: string; steer: string; source?: string; pattern?: string };

/** One of the user's products, for relevance-tagged promotion on X. */
export interface ProductItem { name: string; url?: string; blurb?: string; }
