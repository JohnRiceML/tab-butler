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
  following: number;
}

/** A tweet, flattened from either the new or legacy shape. */
export interface TwttrTweet {
  id: string;
  author: string;        // author handle (screen_name)
  name?: string;         // author display name
  text: string;
  likes?: number;
  replies?: number;
  reposts?: number;
  views?: number;
  postedAt?: number;     // epoch ms
  avatar?: string;
  followers?: number;    // author follower count, when the shape carries it
  authorId?: string;     // author rest_id
  isReply: boolean;      // a reply to someone (vs an original post)
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(x: any): number | undefined {
  const n = typeof x === "string" ? parseInt(x.replace(/[,\s]/g, ""), 10) : x;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function viewCount(views: any): number | undefined {
  return views ? num(views.count) : undefined;
}

/** Parse a /user (by-username) response into the fields we rank/learn on.
 *  Handles the legacy shape (legacy.followers_count) and the new shape
 *  (core.* + relationship_counts.followers). */
export function parseUser(json: any): TwttrUser | null {
  const r = json?.user?.result ?? json?.result ?? json?.data?.user?.result ?? json;
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
    following: num(lg.friends_count) ?? num(rc.following) ?? 0,
  };
}

/** Flatten one tweet "result" object (the thing under tweet_results.result). */
function flattenTweet(result: any): TwttrTweet | null {
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

  const text = String(
    result.note_tweet?.note_tweet_results?.result?.text ??
      result.details?.full_text ??
      result.legacy?.full_text ??
      "",
  );
  if (!text) return null;

  const counts = result.counts ?? {};
  const lg = result.legacy ?? {};
  const likes = num(counts.favorite_count) ?? num(lg.favorite_count);
  const replies = num(counts.reply_count) ?? num(lg.reply_count);
  const reposts = num(counts.retweet_count) ?? num(lg.retweet_count);

  let postedAt: number | undefined = num(result.details?.created_at_ms);
  if (postedAt == null && lg.created_at) {
    const t = Date.parse(lg.created_at);
    if (!Number.isNaN(t)) postedAt = t;
  }

  const isReply = Boolean(
    lg.in_reply_to_status_id_str ||
      lg.in_reply_to_user_id_str ||
      result.reply_to_results ||
      result.reply_to_user_results ||
      /^@\w/.test(text.trim()),
  );

  return {
    id: String(id),
    author: String(author || ""),
    name,
    text,
    likes,
    replies,
    reposts,
    views: viewCount(result.views),
    postedAt,
    avatar,
    followers,
    authorId,
    isReply,
  };
}

/** Every timeline instruction's entries, across both shapes. */
function collectEntries(json: any): any[] {
  const instr =
    json?.result?.timeline_response?.timeline?.instructions ??
    json?.result?.timeline?.instructions ??
    json?.timeline?.instructions ??
    json?.data?.timeline?.instructions ??
    [];
  const out: any[] = [];
  for (const ins of Array.isArray(instr) ? instr : []) {
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

/** Build the voice-profile text stored in settings + fed to the drafter. */
export function buildVoiceProfile(handle: string, samples: string[]): string {
  return (
    `Recent replies @${handle} actually wrote on X. Match this voice, rhythm, vocabulary, and length. Do not copy them verbatim.\n\n` +
    samples.map((s) => `- ${s}`).join("\n")
  );
}
