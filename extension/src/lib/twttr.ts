/**
 * Parsers for the Twttr (RapidAPI) X-data API — host twitter241.p.rapidapi.com.
 * Read-only enrichment for the X reply copilot. The provider returns two
 * DIFFERENT JSON shapes depending on the endpoint, so every reader here is
 * tolerant of both:
 *   - NEW GraphQL shape (e.g. /search-v3): author under
 *     core.user_results.result.core + relationship_counts; text under
 *     details.full_text; counts under counts.*; time as details.created_at_ms.
 *   - LEGACY shape (e.g. /user, /user-replies-v2): author under
 *     core.user_results.result.legacy; text/counts/time under legacy.*.
 * Zero imports on purpose, so it can be unit-tested in isolation
 * (see scripts/test-twttr.mjs).
 */

/** A user, flattened from whichever shape the endpoint returned. */
export interface TwttrUser {
  id: string;        // rest_id (numeric, as a string)
  handle: string;    // screen_name (no @)
  name: string;      // display name
  bio: string;
  followers: number;
  following?: number; // undefined when the response omits it — distinct from a genuine 0 (a broadcaster)
}

/** A tweet, flattened from either the new or legacy shape. */
export interface TwttrTweet {
  id: string;
  author: string;        // author handle (screen_name)
  name?: string;         // author display name
  text: string;
  /** Quoted-post text when the provider embeds it. Context only: scoring/drafting still target the outer author. */
  context?: string;
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;       // quote-post count (quote is a scored head; feeds the outcome loop)
  bookmarks?: number;    // DIAGNOSTIC ONLY — bookmark is confirmed-absent from ranking_scorer.rs; never a ranking input
  views?: number;
  postedAt?: number;     // epoch ms
  /** When this metric snapshot was fetched. Parsers leave it unset; the governor caller stamps it. */
  observedAt?: number;
  avatar?: string;
  followers?: number;    // author follower count, when the shape carries it
  authorId?: string;     // author rest_id
  isReply: boolean;      // a reply to someone (vs an original post)
  replyToId?: string;    // direct parent tweet id when the provider returns it (exact thread completion join)
  lang?: string;         // tweet language code (e.g. "en"), when the shape carries it
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(x: any): number | undefined {
  const n = typeof x === "string" ? parseInt(x.replace(/[,\s]/g, ""), 10) : x;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function viewCount(views: any): number | undefined {
  return views ? num(views.count) : undefined;
}

/** X sometimes wraps a tweet in TweetWithVisibilityResults, and quoted_status_result adds
 * another `result` layer. Normalize both without recursively treating the quote as a timeline row. */
function unwrapTweetResult(value: any): any {
  let node = value?.tweet_results?.result ?? value?.result ?? value;
  if (node?.__typename === "TweetWithVisibilityResults" && node.tweet) node = node.tweet;
  return node;
}

function tweetText(value: any): string {
  const result = unwrapTweetResult(value);
  return String(
    result?.note_tweet?.note_tweet_results?.result?.text ??
      result?.details?.full_text ??
      result?.legacy?.full_text ??
      "",
  ).trim();
}

/** True if a node looks like an X user "result" object (either shape). */
function isUserNode(n: any): boolean {
  return !!n && typeof n === "object" && (n.__typename === "User" || !!n.rest_id || !!n.legacy?.screen_name || !!n.core?.screen_name);
}

/** Recursively find the first user-result node, however the provider wraps it. */
function findUserNode(json: any, depth = 0): any {
  if (!json || typeof json !== "object" || depth > 8) return null;
  if (isUserNode(json) && (json.legacy?.screen_name || json.core?.screen_name || json.rest_id)) return json;
  for (const v of Array.isArray(json) ? json : Object.values(json)) {
    const found = findUserNode(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Parse a /user (by-username) response into the fields we rank/learn on.
 *  Handles the legacy shape (legacy.followers_count), the new shape
 *  (core.* + relationship_counts.followers), and however the provider wraps the
 *  user node (e.g. user.result vs result.data.user.result). */
export function parseUser(json: any): TwttrUser | null {
  // Known direct paths first (precise), then a recursive fallback for any wrapping.
  const candidates = [json?.user?.result, json?.result?.data?.user?.result, json?.data?.user?.result, json?.result?.user?.result, json?.result];
  let r = candidates.find(isUserNode) ?? findUserNode(json);
  if (!r || typeof r !== "object") return null;
  const lg = r.legacy ?? {};
  const core = r.core ?? {};
  const rc = r.relationship_counts ?? {};
  const handle = lg.screen_name ?? core.screen_name ?? "";
  const id = r.rest_id ?? "";
  if (!handle && !id) return null;
  return {
    id: String(id || ""),
    handle: String(handle || ""),
    name: String(lg.name ?? core.name ?? handle ?? ""),
    bio: String(lg.description ?? r.profile_bio?.description ?? ""),
    followers: num(lg.followers_count) ?? num(rc.followers) ?? 0,
    following: num(lg.friends_count) ?? num(rc.following), // undefined when absent, so reciprocity stays neutral (not a fake broadcaster 0)
  };
}

/** Flatten one tweet "result" object (the thing under tweet_results.result). */
function flattenTweet(result: any): TwttrTweet | null {
  result = unwrapTweetResult(result);
  if (!result || typeof result !== "object") return null;
  if (result.__typename && result.__typename !== "Tweet") return null;
  const id = result.rest_id ?? result.legacy?.id_str;
  if (!id) return null;

  const ur = result.core?.user_results?.result ?? {};
  const uLeg = ur.legacy ?? {};
  const uCore = ur.core ?? {};
  const author = uLeg.screen_name ?? uCore.screen_name ?? "";
  const name = uLeg.name ?? uCore.name ?? undefined;
  const avatar = uLeg.profile_image_url_https ?? ur.avatar?.image_url ?? undefined;
  const followers = num(uLeg.followers_count) ?? num(ur.relationship_counts?.followers);
  const authorId = ur.rest_id ? String(ur.rest_id) : undefined;

  const text = tweetText(result);
  if (!text) return null;
  const quotedResult = unwrapTweetResult(result.quoted_status_result);
  const quotedText = tweetText(quotedResult);
  const quotedId = quotedResult?.rest_id ?? quotedResult?.legacy?.id_str;
  const context = quotedText && String(quotedId || "") !== String(id) && quotedText !== text ? quotedText : undefined;

  const counts = result.counts ?? {};
  const lg = result.legacy ?? {};
  const likes = num(counts.favorite_count) ?? num(lg.favorite_count);
  const replies = num(counts.reply_count) ?? num(lg.reply_count);
  const reposts = num(counts.retweet_count) ?? num(lg.retweet_count);
  const quotes = num(counts.quote_count) ?? num(lg.quote_count);
  const bookmarks = num(counts.bookmark_count) ?? num(lg.bookmark_count); // diagnostic only, never a ranking input

  let postedAt: number | undefined = num(result.details?.created_at_ms);
  if (postedAt == null && lg.created_at) {
    const t = Date.parse(lg.created_at);
    if (!Number.isNaN(t)) postedAt = t;
  }

  const replyToIdRaw = lg.in_reply_to_status_id_str ?? result.reply_to_results?.rest_id ?? result.reply_to_results?.result?.rest_id;
  const replyToId = replyToIdRaw != null && String(replyToIdRaw) ? String(replyToIdRaw) : undefined;
  const isReply = Boolean(
    replyToId ||
      lg.in_reply_to_user_id_str ||
      result.reply_to_results ||
      result.reply_to_user_results ||
      /^@\w/.test(text.trim()),
  );
  const lang = result.details?.lang ?? lg.lang ?? undefined; // details-first, legacy fallback (mirrors text)

  return {
    id: String(id),
    author: String(author || ""),
    name,
    text,
    context,
    likes,
    replies,
    reposts,
    quotes,
    bookmarks,
    views: viewCount(result.views),
    postedAt,
    avatar,
    followers,
    authorId,
    isReply,
    replyToId,
    lang,
  };
}

/** The first `instructions` array found anywhere in the response (the stable
 *  anchor across all GraphQL timeline shapes, regardless of how it's wrapped). */
function findInstructions(json: any, depth = 0): any[] {
  if (!json || typeof json !== "object" || depth > 10) return [];
  if (Array.isArray(json.instructions)) return json.instructions;
  for (const v of Array.isArray(json) ? json : Object.values(json)) {
    const r = findInstructions(v, depth + 1);
    if (r.length) return r;
  }
  return [];
}

/** Every timeline instruction's entries, across both shapes and any wrapping. */
function collectEntries(json: any): any[] {
  const instr =
    json?.result?.timeline_response?.timeline?.instructions ??
    json?.result?.timeline?.instructions ??
    json?.timeline?.instructions ??
    json?.data?.timeline?.instructions ??
    null;
  const list = Array.isArray(instr) ? instr : findInstructions(json);
  const out: any[] = [];
  for (const ins of list) {
    if (ins?.entry) out.push(ins.entry);                 // TimelinePinEntry
    if (Array.isArray(ins?.entries)) out.push(...ins.entries);
  }
  return out;
}

/** The tweet result(s) carried by one entry: the top-level item plus any
 *  conversation-module items. Handles new (content.content) and legacy
 *  (content.itemContent) item nesting, and module items[] of either form. */
function entryTweetResults(entry: any): any[] {
  const out: any[] = [];
  const content = entry?.content;
  if (!content) return out;
  const item = content.content ?? content.itemContent;
  const r = item?.tweet_results?.result;
  if (r) out.push(r);
  if (Array.isArray(content.items)) {
    for (const it of content.items) {
      const ic = it?.item?.content ?? it?.item?.itemContent;
      const rr = ic?.tweet_results?.result;
      if (rr) out.push(rr);
    }
  }
  return out;
}

/** All tweets in a timeline response (search results, user replies, etc.),
 *  deduped by id, in document order. */
export function parseTimelineTweets(json: any): TwttrTweet[] {
  const seen = new Set<string>();
  const out: TwttrTweet[] = [];
  for (const entry of collectEntries(json)) {
    for (const r of entryTweetResults(entry)) {
      const t = flattenTweet(r);
      if (t && !seen.has(t.id)) {
        seen.add(t.id);
        out.push(t);
      }
    }
  }
  return out;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Fresh, original (non-reply) posts to surface as discovery candidates,
 *  most recent first. Reply-to-others posts are dropped (we want posts to
 *  reply TO, not threads someone else is already deep in). */
export function pickDiscoveryTweets(json: unknown, max = 18): TwttrTweet[] {
  return parseTimelineTweets(json)
    .filter((t) => t.author && t.text && !t.isReply)
    .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))
    .slice(0, max);
}

/** Clean one of the user's own replies into a voice sample: drop the leading
 *  @mentions and any t.co links, collapse whitespace. */
function cleanSample(text: string): string {
  return text
    .replace(/^(?:@\w+\s+)+/, "")        // leading reply mentions
    .replace(/https?:\/\/\S+/g, "")      // t.co links
    .replace(/\s+/g, " ")
    .trim();
}

/** The user's own substantive recent replies, as voice samples. Keeps replies
 *  the user authored (authorId === userId), strips mentions/links, and drops
 *  one-word reactions / emoji-only quips that teach the drafter nothing. */
export function pickVoiceSamples(json: unknown, userId: string, max = 12): string[] {
  const own = parseTimelineTweets(json).filter((t) => t.authorId && t.authorId === String(userId));
  const replies = own.filter((t) => t.isReply);
  const base = replies.length >= 4 ? replies : own;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of base) {
    const s = cleanSample(t.text);
    const words = s.split(/\s+/).filter(Boolean);
    if (s.length < 16 || words.length < 3 || !/[a-zA-Z]/.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** One of the user's own recent original posts, with the real engagement X reports. */
export interface OwnPost { id: string; text: string; postedAt?: number; views?: number; likes?: number; reposts?: number; replies?: number; }

/** The user's own recent ORIGINAL posts WITH X's reported engagement (views/likes/...),
 *  newest first — powers the momentum "real views today" stat. `views` is whatever X
 *  reported (may be undefined on some tweets / API shapes). Text cleaned like pickOwnPosts. */
export function pickOwnPostsWithStats(json: unknown, handle: string, max = 15): OwnPost[] {
  const h = handle.toLowerCase();
  return parseTimelineTweets(json)
    .filter((t) => t.author?.toLowerCase() === h && !t.isReply && t.text)
    .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))
    .map((t) => ({ id: t.id, text: t.text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim(), postedAt: t.postedAt, views: t.views, likes: t.likes, reposts: t.reposts, replies: t.replies }))
    .filter((p) => p.text.length >= 20)
    .slice(0, max);
}

/** The user's own recent ORIGINAL posts (not replies), newest first, links/whitespace
 *  stripped — fed to the post-ideas generator to de-dupe against + match their real voice. */
export function pickOwnPosts(json: unknown, handle: string, max = 15): string[] {
  const h = handle.toLowerCase();
  return parseTimelineTweets(json)
    .filter((t) => t.author?.toLowerCase() === h && !t.isReply && t.text)
    .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))
    .map((t) => t.text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 20)
    .slice(0, max);
}

/** Build the voice-profile text stored in settings + fed to the drafter. */
export function buildVoiceProfile(handle: string, samples: string[]): string {
  return (
    `Recent replies @${handle} actually wrote on X. Match this voice, rhythm, vocabulary, and length. Do not copy them verbatim.\n\n` +
    samples.map((s) => `- ${s}`).join("\n")
  );
}

/** The SEARCH-facing slice of the user's niche. The niche setting does double duty: the FULL text
 *  goes to the Claude scorer as intent ("posts I can add a build lesson to" helps it judge fit),
 *  but X search treats every word as a keyword — an intent clause poisons the query and starves
 *  the pool. Convention (modeled by the popup placeholder): search keywords first, then ";" or a
 *  newline, then intent. Search paths use only the keyword clause; prompts keep everything.
 *  No ";"/newline → unchanged. Degenerate input (empty first clause) falls back to the full trim. */
export function nicheQuery(niche: string): string {
  const first = (niche || "").split(/[;\n]/, 1)[0].trim();
  return first || (niche || "").trim();
}

/** The niche's topic phrases: the keyword clause split on commas / slashes, ≥2 chars each.
 *  "AI builders, indie SaaS founders" → ["AI builders", "indie SaaS founders"]. */
export function nicheTopics(niche: string): string[] {
  return nicheQuery(niche).split(/\s*[,/]\s*/).map((p) => p.trim()).filter((p) => p.length >= 2);
}

/** Build an X search query that matches ANY of the user's topics, not ALL their keywords. A niche
 *  like "AI builders, indie SaaS founders" sent raw is an implicit AND of five words — almost no
 *  tweet contains all of them, so the pool comes back EMPTY ("try a broader niche"). We OR the
 *  parenthesized topic groups so a post about EITHER topic qualifies: `((AI builders) OR (indie SaaS
 *  founders))`. One topic → returned bare. `extra` appends server-side operators (lang/filters).
 *  Capped at 4 topics so the OR stays sane. */
export function nicheSearchQuery(niche: string, extra = ""): string {
  const topics = nicheTopics(niche).slice(0, 4);
  const core = topics.length <= 1
    ? (topics[0] ?? nicheQuery(niche)).slice(0, 100)
    : `(${topics.map((t) => `(${t})`).join(" OR ")})`;
  return (extra ? `${core} ${extra}` : core).trim();
}

/**
 * Operator-free Top-search rotations for Fresh Reach account exploration. The first query preserves
 * the user's full topic expression; later rotations broaden one topic/keyword at a time so repeated
 * explicit hunts can discover new authors instead of replaying one cached result forever. Content
 * scoring remains the relevance gate, and the list is deterministic so callers can persist/rotate.
 */
export function nicheExplorationQueries(niche: string): string[] {
  const base = nicheSearchQuery(niche);
  const topics = nicheTopics(niche).slice(0, 4);
  const words = topics.flatMap((topic) => topic.split(/\s+/))
    .map((word) => word.replace(/[^a-z0-9_+#.-]/gi, "").trim())
    .filter((word) => word.length >= 2);
  return [...new Set([base, ...topics, ...words].filter(Boolean))].slice(0, 10);
}

/**
 * Fresh Reach also needs discovery beyond the niche bubble: a large general-interest account may
 * later publish a post where the user has a genuinely relevant contribution. Interleave focused
 * rotations with broad, operator-free Top searches so repeated clicks expand both pools. These are
 * discovery seeds—not trend claims or relevance evidence; the individual-post scorer remains the
 * hard gate before anything reaches the reply queue.
 */
export function freshReachExplorationQueries(niche: string): string[] {
  const focused = nicheExplorationQueries(niche);
  const broad = ["technology", "business", "AI", "science", "creators", "design", "marketing", "startups", "culture", "sports", "entertainment"];
  const interleaved: string[] = [];
  const length = Math.max(focused.length, broad.length);
  for (let i = 0; i < length; i++) {
    if (focused[i]) interleaved.push(focused[i]);
    if (broad[i]) interleaved.push(broad[i]);
  }
  return [...new Set(interleaved.filter(Boolean))].slice(0, 20);
}
