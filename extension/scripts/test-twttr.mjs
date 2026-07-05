/**
 * Unit test for the Twttr parsers, run with `node scripts/test-twttr.mjs`.
 * twttr.ts has zero imports, so we transpile it with esbuild and import the
 * result from a data URL — no build step, no test framework. Fixtures mirror
 * the two real provider shapes (new GraphQL for /search-v3, legacy for /user
 * and /user-replies-v2) exactly as observed from twitter241.p.rapidapi.com.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/twttr.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { parseUser, parseTimelineTweets, pickDiscoveryTweets, pickVoiceSamples, pickOwnPosts, pickOwnPostsWithStats, buildVoiceProfile, nicheQuery, nicheTopics, nicheSearchQuery } = mod;

let pass = 0,
  fail = 0;
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", label); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

/* ---- /user (legacy shape) ---- */
const userJson = {
  user: {
    result: {
      __typename: "User",
      rest_id: "2455740283",
      legacy: { screen_name: "MrBeast", name: "MrBeast", description: "CEO", followers_count: 20700602, friends_count: 1924 },
    },
  },
};
const u = parseUser(userJson);
eq(u.id, "2455740283", "parseUser id");
eq(u.handle, "MrBeast", "parseUser handle");
eq(u.followers, 20700602, "parseUser followers");
eq(u.following, 1924, "parseUser following");
// new-shape user (core + relationship_counts)
const u2 = parseUser({ user: { result: { rest_id: "9", core: { screen_name: "alice", name: "Alice" }, relationship_counts: { followers: 5000, following: 10 } } } });
eq(u2.followers, 5000, "parseUser new-shape followers");
eq(u2.handle, "alice", "parseUser new-shape handle");
ok(parseUser({}) === null, "parseUser empty -> null");
// LIVE shape: the provider wraps the user under result.data.user.result (raw GraphQL), new-shape fields
const wrappedUser = { result: { data: { user: { result: { __typename: "User", rest_id: "2455740283", core: { name: "MrBeast", screen_name: "MrBeast" }, relationship_counts: { followers: 34750652, following: 2301 }, profile_bio: { description: "bio" } } } } } };
const wu = parseUser(wrappedUser);
eq(wu.id, "2455740283", "parseUser wrapped result.data.user.result id");
eq(wu.handle, "MrBeast", "parseUser wrapped handle (core.screen_name)");
eq(wu.followers, 34750652, "parseUser wrapped followers (relationship_counts)");
// following must be undefined (not a fake 0) when the response omits it — keeps reciprocity neutral
const uNoFollow = parseUser({ user: { result: { rest_id: "5", legacy: { screen_name: "x", followers_count: 100 } } } });
eq(uNoFollow.following, undefined, "following undefined when absent (not a broadcaster 0)");

/* ---- /search-v3 (new GraphQL shape) ---- */
const searchJson = {
  result: {
    timeline_response: {
      timeline: {
        instructions: [
          {
            __typename: "TimelineAddEntries",
            entries: [
              {
                __typename: "TimelineTimelineEntry",
                content: {
                  __typename: "TimelineTimelineItem",
                  content: {
                    __typename: "TimelineTweet",
                    tweet_results: {
                      result: {
                        __typename: "Tweet",
                        rest_id: "t1",
                        core: {
                          user_results: {
                            result: {
                              __typename: "User",
                              rest_id: "u1",
                              core: { name: "Alice", screen_name: "alice" },
                              avatar: { image_url: "https://av/alice.jpg" },
                              relationship_counts: { followers: 5000, following: 100 },
                            },
                          },
                        },
                        counts: { favorite_count: 36776, reply_count: 6089, retweet_count: 1411 },
                        details: { full_text: "If USA wins the World Cup we are calling it soccer forever", created_at_ms: 1782079947000 },
                        views: { count: "2723034" },
                      },
                    },
                  },
                },
                entry_id: "tweet-t1",
              },
              // a reply (should be excluded from discovery)
              {
                content: {
                  content: {
                    __typename: "TimelineTweet",
                    tweet_results: {
                      result: {
                        __typename: "Tweet",
                        rest_id: "t2",
                        core: { user_results: { result: { rest_id: "u2", core: { name: "Bob", screen_name: "bob" }, relationship_counts: { followers: 50 } } } },
                        counts: { favorite_count: 4, reply_count: 1 },
                        details: { full_text: "@alice good take", created_at_ms: 1782000000000 },
                      },
                    },
                  },
                },
                entry_id: "tweet-t2",
              },
              // a reply marked ONLY by the structured field reply_to_results, with NO leading @ in the text
              // (X strips the @mention on in-conversation replies) — the robust path, must still be caught
              {
                content: {
                  content: {
                    __typename: "TimelineTweet",
                    tweet_results: {
                      result: {
                        __typename: "Tweet",
                        rest_id: "t3",
                        core: { user_results: { result: { rest_id: "u3", core: { name: "Cara", screen_name: "cara" }, relationship_counts: { followers: 300 } } } },
                        counts: { favorite_count: 9, reply_count: 0 },
                        details: { full_text: "this is the part everyone misses about distribution", created_at_ms: 1781999999000 },
                        reply_to_results: { rest_id: "t1" },
                      },
                    },
                  },
                },
                entry_id: "tweet-t3",
              },
              // a reply marked ONLY by reply_to_user_results (no reply_to_results, no @ prefix)
              {
                content: {
                  content: {
                    __typename: "TimelineTweet",
                    tweet_results: {
                      result: {
                        __typename: "Tweet",
                        rest_id: "t4",
                        core: { user_results: { result: { rest_id: "u4", core: { name: "Dan", screen_name: "dan" }, relationship_counts: { followers: 80 } } } },
                        counts: { favorite_count: 2, reply_count: 0 },
                        details: { full_text: "agreed, shipping daily changed everything for us", created_at_ms: 1781888888000 },
                        reply_to_user_results: { result: { rest_id: "u1" } },
                      },
                    },
                  },
                },
                entry_id: "tweet-t4",
              },
              { content: { __typename: "TimelineTimelineCursor", cursor_type: "Bottom", value: "abc" }, entry_id: "cursor-bottom-0" },
            ],
          },
        ],
      },
    },
  },
};
const st = parseTimelineTweets(searchJson);
eq(st.length, 4, "search parseTimeline count");
const t1 = st.find((t) => t.id === "t1");
eq(t1.author, "alice", "search author");
eq(t1.name, "Alice", "search name");
eq(t1.likes, 36776, "search likes");
eq(t1.replies, 6089, "search replies");
eq(t1.postedAt, 1782079947000, "search postedAt");
eq(t1.avatar, "https://av/alice.jpg", "search avatar");
eq(t1.followers, 5000, "search author followers");
eq(t1.views, 2723034, "search views");
eq(t1.isReply, false, "search t1 not a reply");
const t2 = st.find((t) => t.id === "t2");
eq(t2.isReply, true, "search t2 is a reply (@-prefixed)");
const t3 = st.find((t) => t.id === "t3");
eq(t3.isReply, true, "search reply via reply_to_results (no @ prefix)");
const t4 = st.find((t) => t.id === "t4");
eq(t4.isReply, true, "search reply via reply_to_user_results only (no @ prefix)");
const disc = pickDiscoveryTweets(searchJson, 18);
eq(disc.length, 1, "discovery drops all replies (structured + @-prefixed)");
eq(disc[0].id, "t1", "discovery keeps original post");

// LIVE wrapping: instructions nested deep under result.data.<...>.timeline.instructions
const wrappedTimeline = { result: { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [
  { __typename: "TimelineAddEntries", entries: [
    { content: { content: { __typename: "TimelineTweet", tweet_results: { result: {
      __typename: "Tweet", rest_id: "w1",
      core: { user_results: { result: { rest_id: "uw", core: { name: "Zoe", screen_name: "zoe" }, relationship_counts: { followers: 900 } } } },
      counts: { favorite_count: 3, reply_count: 0 },
      details: { full_text: "building in public is underrated", created_at_ms: 1782000000000 },
    } } } }, entry_id: "tweet-w1" },
  ] },
] } } } } } };
const wt = parseTimelineTweets(wrappedTimeline);
eq(wt.length, 1, "findInstructions reaches deeply-wrapped instructions");
eq(wt[0].id, "w1", "wrapped timeline tweet parsed");
eq(wt[0].author, "zoe", "wrapped timeline author");

/* ---- /user-replies-v2 (legacy shape, with a conversation module) ---- */
const meId = "me1";
const reply = (rest_id, full_text, extra = {}) => ({
  content: {
    __typename: "TimelineTimelineItem",
    itemContent: {
      __typename: "TimelineTweet",
      tweet_results: {
        result: {
          __typename: "Tweet",
          rest_id,
          core: { user_results: { result: { rest_id: meId, legacy: { screen_name: "me", name: "Me" } } } },
          legacy: { full_text, favorite_count: 5, reply_count: 1, user_id_str: meId, in_reply_to_status_id_str: "x", created_at: "Sat Mar 23 16:18:30 +0000 2024", ...extra },
        },
      },
    },
  },
  entryId: "tweet-" + rest_id,
});
const repliesJson = {
  result: {
    timeline: {
      instructions: [
        { type: "TimelineClearCache" },
        {
          // pinned original post by me (not a reply) — should not be a voice sample
          entry: {
            content: {
              __typename: "TimelineTimelineItem",
              itemContent: { __typename: "TimelineTweet", tweet_results: { result: { __typename: "Tweet", rest_id: "pin1", core: { user_results: { result: { rest_id: meId, legacy: { screen_name: "me", name: "Me" } } } }, legacy: { full_text: "No takesies backsies", favorite_count: 1, user_id_str: meId, created_at: "Mon May 09 14:42:25 +0000 2022" } } } },
            },
            entryId: "tweet-pin1",
          },
          type: "TimelinePinEntry",
        },
        {
          type: "TimelineAddEntries",
          entries: [
            reply("r1", "@bob good point, the trick is to ship daily and measure what sticks"),
            reply("r2", "@carol Netflix really missed out on a bag here, wild decision"),
            reply("r3", "🥰"), // emoji-only — dropped
            reply("r4", "ok"), // too short — dropped
            // a who-to-follow module (TimelineUser items, no tweet_results) — ignored
            {
              content: {
                __typename: "TimelineTimelineModule",
                items: [
                  { entryId: "wtf-1", item: { itemContent: { __typename: "TimelineUser", user_results: { result: { rest_id: "x" } } } } },
                ],
              },
              entryId: "who-to-follow-1",
            },
            // a conversation module: someone else's original + my reply inside items[]
            {
              content: {
                __typename: "TimelineTimelineModule",
                items: [
                  { entryId: "conv-a", item: { itemContent: { __typename: "TimelineTweet", tweet_results: { result: { __typename: "Tweet", rest_id: "orig1", core: { user_results: { result: { rest_id: "u9", legacy: { screen_name: "stranger", name: "Stranger" } } } }, legacy: { full_text: "Original post from someone else", favorite_count: 9, created_at: "Sat Mar 16 16:02:57 +0000 2024" } } } } } },
                  { entryId: "conv-b", item: { itemContent: { __typename: "TimelineTweet", tweet_results: { result: { __typename: "Tweet", rest_id: "r5", core: { user_results: { result: { rest_id: meId, legacy: { screen_name: "me", name: "Me" } } } }, legacy: { full_text: "@stranger this is the part everyone misses about distribution", favorite_count: 7, user_id_str: meId, in_reply_to_status_id_str: "orig1", created_at: "Sat Mar 16 16:33:59 +0000 2024" } } } } } },
                ],
              },
              entryId: "profile-conversation-1",
            },
          ],
        },
      ],
    },
  },
};
const rt = parseTimelineTweets(repliesJson);
ok(rt.some((t) => t.id === "r1"), "replies: top-level reply parsed");
ok(rt.some((t) => t.id === "orig1"), "replies: module original parsed");
ok(rt.some((t) => t.id === "r5"), "replies: module reply parsed");
ok(rt.some((t) => t.id === "pin1"), "replies: pinned entry parsed");
const samples = pickVoiceSamples(repliesJson, meId, 12);
ok(samples.includes("good point, the trick is to ship daily and measure what sticks"), "voice: r1 mention stripped + kept");
ok(samples.includes("this is the part everyone misses about distribution"), "voice: module reply kept");
ok(!samples.some((s) => s === "🥰" || s === "ok"), "voice: drops emoji-only / too-short");
ok(!samples.includes("No takesies backsies"), "voice: drops pinned original (prefers replies)");
ok(samples.every((s) => !s.startsWith("@")), "voice: no leading @mentions remain");
const vp = buildVoiceProfile("me", samples);
ok(vp.includes("@me") && vp.includes("- good point"), "voice profile shape");

/* ---- own posts (idea de-dupe source): originals only, by handle ---- */
const own = pickOwnPosts(repliesJson, "me", 15);
ok(own.includes("No takesies backsies"), "own: keeps my original post");
ok(!own.some((s) => s.includes("ship daily")), "own: drops my replies");
ok(!own.some((s) => s.includes("Original post from someone else")), "own: drops other people's posts");
eq(pickOwnPosts({}, "me"), [], "own empty -> []");

/* ---- own posts WITH stats (momentum views) ---- */
const ownS = pickOwnPostsWithStats(repliesJson, "me", 15);
ok(ownS.some((p) => p.text === "No takesies backsies" && p.likes === 1), "own-stats: original kept with real engagement");
ok(ownS.every((p) => p.text !== "good point, the trick is to ship daily and measure what sticks"), "own-stats: drops replies");
eq(pickOwnPostsWithStats({}, "me"), [], "own-stats empty -> []");

/* ---- nicheQuery: search gets the keyword clause, prompts keep the full niche ---- */
ok(nicheQuery("AI SaaS, indie founders, MRR; posts I can add a build lesson to") === "AI SaaS, indie founders, MRR", "keyword clause before the ; drives search");
ok(nicheQuery("AI builders\nposts with real numbers") === "AI builders", "a newline splits the same way");
ok(nicheQuery("AI builders, indie SaaS") === "AI builders, indie SaaS", "no separator -> unchanged");
ok(nicheQuery("  ; only intent here") === "; only intent here", "degenerate empty first clause falls back to the full trim");
ok(nicheQuery("") === "", "empty stays empty");

/* ---- nicheSearchQuery: OR the topics so search matches ANY, not ALL keywords (the empty-pool fix) ---- */
ok(nicheTopics("AI builders, indie SaaS founders; intent here").join("|") === "AI builders|indie SaaS founders", "topics split on comma, intent clause dropped");
ok(nicheTopics("AI/ML, robotics").join("|") === "AI|ML|robotics", "slashes split too");
ok(nicheSearchQuery("AI builders, indie SaaS founders; intent") === "((AI builders) OR (indie SaaS founders))", "multi-topic -> OR of parenthesized groups");
ok(nicheSearchQuery("AI builders, indie SaaS founders", "lang:en -giveaway") === "((AI builders) OR (indie SaaS founders)) lang:en -giveaway", "operators append after the OR group");
ok(nicheSearchQuery("AI builders", "lang:en") === "AI builders lang:en", "single topic -> bare + operators");
ok(nicheSearchQuery("aa, bb, cc, dd, ee, ff").split(" OR ").length === 4, "caps at 4 topics so the OR doesn't explode");
ok(nicheSearchQuery("") === "", "empty niche -> empty query");

/* ---- robustness ---- */
eq(parseTimelineTweets(null), [], "null -> []");
eq(parseTimelineTweets({}), [], "empty -> []");
eq(pickVoiceSamples({}, "x"), [], "voice empty -> []");

console.log(fail === 0 ? `\n✓ twttr parsers: ${pass} assertions passed` : `\n✗ twttr parsers: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
