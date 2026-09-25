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

export type SocialPlatform = "x" | "linkedin";

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
  | { type: "OPEN_SIDE_PANEL" }
  | { type: "GROUP_NOW" }
  | { type: "ADVISE_NOW" }
  | { type: "ARCHIVE_IDLE_NOW" }
  | { type: "UNDO_LAST" }
  | { type: "APPLY_REC"; kind: RecommendationKind; tabIds: number[] }
  | { type: "SCORE_POSTS"; platform?: "x"; posts: { i: number; author: string; text: string; meta?: string; context?: string }[] }
  | { type: "DRAFT_REPLY"; platform?: "x"; author: string; text: string; context?: string; angle?: string; product?: string; steer?: string; style?: string; reason?: string; category?: string; anchor?: string; replyBrief?: string; authorLine?: string; threadLine?: string; opportunityLine?: string }
  | { type: "LI_BROKER_STATUS" }
  | { type: "LI_SCORE_POSTS"; posts: { i: number; author: string; text: string; meta?: string; context?: string; authorHeadline?: string; authorKind?: string; connectionDegree?: string }[] }
  | { type: "LI_DRAFT_COMMENT"; author: string; text: string; context?: string; steer?: string; currentDraft?: string; personalDetail?: string; reason?: string; category?: string; anchor?: string; replyMove?: string; replyBrief?: string; opportunityLine?: string; authorHeadline?: string; authorKind?: string; connectionDegree?: string; personReason?: string; commentLane?: string }
  | { type: "LI_START_COMMENT_REVIEW"; postId: string; author: string; permalink?: string }
  | { type: "LI_DISMISS_COMMENT_REVIEW"; postId: string }
  | { type: "LI_MARK_POSTED"; postId: string; author: string; authorKey?: string; permalink?: string }
  | { type: "LI_UNDO_POSTED"; postId: string; postedAt: number; author?: string; permalink?: string }
  | { type: "LI_GET_ACTIVITY" }
  | { type: "OPEN_REPLY_POST"; postId: string; author: string }
  | { type: "DRAFT_DM"; handle: string; intent: string; phase: "first" | "follow_up" | "reply"; goal?: string; recipient?: { name?: string; bio?: string; followers?: number }; product?: { name: string; url?: string; blurb?: string }; reasons?: { label: string; detail?: string; source?: string }[]; context?: { kind: string; text?: string; url?: string }[]; priorMessages?: { direction: string; phase: string; text?: string; at?: number }[] }
  | { type: "GET_FAVICONS"; hosts: string[] }
  | { type: "TWTTR_GET"; path: string; query?: Record<string, string>; intent?: boolean }
  | { type: "GET_TWTTR_METER" }
  | { type: "POST_IDEAS"; posts: { author: string; text: string; likes?: number; reposts?: number; followers?: number; shape?: string }[]; ownPosts?: { text: string; likes?: number; reposts?: number }[]; followers?: number; shapeLine?: string; strategyLine?: string }
  | { type: "POST_IDEA_REWRITE"; text: string; steer: string; source?: string; pattern?: string };

/** One of the user's products, for relevance-tagged promotion on X. */
export interface ProductItem { name: string; url?: string; blurb?: string; }
