/**
 * Conservative attribution for Post Ideas -> real posts returned by RapidAPI.
 *
 * This module deliberately does not do fuzzy matching. A plausible-but-wrong match would teach
 * the generator the wrong lesson and make the shipped history look more certain than the data is.
 * We accept only one exact normalized idea <-> one exact normalized post, created after the idea.
 */

export interface IdeaPublication {
  postId: string;
  confidence: "exact";
  matchedAt: number;
  measuredAt: number;
  postedAt?: number;
  views?: number;
  likes?: number;
  reposts?: number;
  replies?: number;
}

export interface AttributableIdea {
  id: string;
  text: string;
  status: "working" | "posted";
  createdAt: number;
  postedAt?: number;
  publication?: IdeaPublication;
}

export interface PublishedPost {
  id: string;
  text: string;
  postedAt?: number;
  views?: number;
  likes?: number;
  reposts?: number;
  replies?: number;
}

export const IDEA_POST_MATCH_SLACK_MS = 5 * 60_000;

/** Normalize transport-only differences while preserving the actual words and punctuation. */
export function normalizePublishedText(text: string): string {
  return (text || "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function publicationFor(post: PublishedPost, now: number, matchedAt = now): IdeaPublication {
  return {
    postId: post.id,
    confidence: "exact",
    matchedAt,
    measuredAt: now,
    postedAt: post.postedAt,
    views: post.views,
    likes: post.likes,
    reposts: post.reposts,
    replies: post.replies,
  };
}

function samePublication(a: IdeaPublication, b: IdeaPublication): boolean {
  return a.postId === b.postId && a.confidence === b.confidence && a.postedAt === b.postedAt &&
    a.views === b.views && a.likes === b.likes && a.reposts === b.reposts && a.replies === b.replies;
}

export interface ReconcileResult<T extends AttributableIdea> { ideas: T[]; changed: boolean; matched: number; updated: number; }

/**
 * Update existing exact matches, then claim new matches only when both sides are unique.
 * A post must not predate creation of the idea (apart from a tiny clock/refresh slack).
 */
export function reconcileIdeaPublications<T extends AttributableIdea>(ideas: T[], posts: PublishedPost[], now: number): ReconcileResult<T> {
  const postById = new Map(posts.filter((p) => p?.id).map((p) => [p.id, p]));
  const claimed = new Set<string>();
  let changed = false, matched = 0, updated = 0;

  let next = ideas.map((idea) => {
    if (!idea.publication?.postId) return idea;
    claimed.add(idea.publication.postId);
    const post = postById.get(idea.publication.postId);
    if (!post) return idea; // keep the last measured result after it rolls out of the 15-post cache
    const publication = publicationFor(post, now, idea.publication.matchedAt);
    const postedAt = post.postedAt ?? idea.postedAt;
    if (samePublication(idea.publication, publication) && idea.status === "posted" && idea.postedAt === postedAt) return idea;
    changed = true; updated++;
    return { ...idea, status: "posted" as const, postedAt, publication };
  });

  const ideasByText = new Map<string, number[]>();
  for (let i = 0; i < next.length; i++) {
    const idea = next[i];
    if (idea.publication) continue;
    const key = normalizePublishedText(idea.text);
    if (key.length < 20) continue;
    const xs = ideasByText.get(key); if (xs) xs.push(i); else ideasByText.set(key, [i]);
  }
  const postsByText = new Map<string, PublishedPost[]>();
  for (const post of posts) {
    if (!post?.id || claimed.has(post.id)) continue;
    const key = normalizePublishedText(post.text);
    if (key.length < 20) continue;
    const xs = postsByText.get(key); if (xs) xs.push(post); else postsByText.set(key, [post]);
  }

  for (const [key, indexes] of ideasByText) {
    if (indexes.length !== 1) continue; // duplicate stored drafts are ambiguous
    const candidates = (postsByText.get(key) ?? []).filter((post) => {
      const at = post.postedAt;
      return at != null && at >= next[indexes[0]].createdAt - IDEA_POST_MATCH_SLACK_MS;
    });
    if (candidates.length !== 1) continue; // repeated real posts are ambiguous too
    const index = indexes[0], post = candidates[0], idea = next[index];
    next[index] = { ...idea, status: "posted", postedAt: post.postedAt ?? idea.postedAt ?? now, publication: publicationFor(post, now) };
    claimed.add(post.id); changed = true; matched++;
  }

  return { ideas: next, changed, matched, updated };
}
