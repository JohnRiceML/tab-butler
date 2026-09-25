/** Pure trust-boundary tests for src/lib/linkedin-policy.ts. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/lib/linkedin-policy.ts"), "utf8");
const js = esbuild.transformSync(source, { loader: "ts", format: "esm" }).code;
const policy = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (condition, label) => {
  if (condition) pass += 1;
  else { fail += 1; console.error("  FAIL:", label); }
};
const eq = (actual, expected, label) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass += 1;
  else { fail += 1; console.error("  FAIL:", label, "got", JSON.stringify(actual), "want", JSON.stringify(expected)); }
};

const { LI_CONSENT_VERSION, LI_SCORE_MAX_BATCH, LI_PAYLOAD_LIMITS, isSupportedLinkedInUrl,
  hasSupportedLinkedInSenderUrl, canUseLinkedInBroker, sanitizeLinkedInScorePayload, sanitizeLinkedInDraftPayload,
  sanitizeLinkedInBrokerPayload } = policy;

// Canonical LinkedIn route matrix. Only www + HTTPS + the supported feed/post routes pass.
eq(LI_CONSENT_VERSION, "v5", "one canonical LinkedIn consent version");
for (const url of [
  "https://www.linkedin.com/feed",
  "https://www.linkedin.com/feed/",
  "https://www.linkedin.com/feed/?trk=homepage-basic_sign-in-submit",
  "https://www.linkedin.com/feed/update/urn:li:activity:7340123456789012345/",
  "https://www.linkedin.com/feed/update/urn:li:activity:7340123456789012345/?utm_source=share#comments",
  "https://www.linkedin.com/posts/jane-doe_specific-topic-activity-7340123456789012345-Ab_C/",
]) ok(isSupportedLinkedInUrl(url), `supported LinkedIn route: ${url}`);

for (const url of [
  "https://linkedin.com/feed/",
  "https://m.linkedin.com/feed/",
  "http://www.linkedin.com/feed/",
  "https://www.linkedin.com/",
  "https://www.linkedin.com/groups/123/",
  "https://www.linkedin.com/jobs/",
  "https://www.linkedin.com/messaging/",
  "https://www.linkedin.com/search/results/content/",
  "https://www.linkedin.com/in/jane-doe/",
  "https://www.linkedin.com/company/acme/",
  "https://www.linkedin.com/feed/following/",
  "https://www.linkedin.com/feed/update/urn:li:ugcPost:7340123456789012345/",
  "https://www.linkedin.com/posts/not-a-canonical-activity/",
  "https://www.linkedin.com/posts/topic-activity-12345-code/",
  "https://www.linkedin.com/posts/topic-activity-7340123456789012345-code/extra",
  "https://www.linkedin.com.evil.example/feed/",
  "https://www.linkedin.com@evil.example/feed/",
  "not a url",
  " https://www.linkedin.com/feed/ ",
]) ok(!isSupportedLinkedInUrl(url), `rejected LinkedIn route: ${url}`);

ok(hasSupportedLinkedInSenderUrl("chrome-extension://goobi/linkedin-copilot.js", "https://www.linkedin.com/feed/"), "supported tab URL wins when Chrome reports the extension script as sender.url");
ok(hasSupportedLinkedInSenderUrl("https://www.linkedin.com/feed/", "https://www.linkedin.com/notifications/"), "supported frame URL wins during a stale SPA tab snapshot");
ok(!hasSupportedLinkedInSenderUrl("chrome-extension://goobi/linkedin-copilot.js", "https://www.linkedin.com/notifications/"), "untrusted extension and unsupported LinkedIn URLs stay blocked");

// Gate matrix: exact version, exact boolean, nonblank string key.
ok(canUseLinkedInBroker("v5", true, "sk-ant-test"), "current consent + enabled + key opens gate");
ok(!canUseLinkedInBroker(undefined, true, "sk-ant-test"), "missing consent closes gate");
ok(!canUseLinkedInBroker("v0", true, "sk-ant-test"), "old consent closes gate");
ok(!canUseLinkedInBroker("v6", true, "sk-ant-test"), "future consent closes gate");
ok(!canUseLinkedInBroker("v5", false, "sk-ant-test"), "disabled closes gate");
ok(!canUseLinkedInBroker("v5", 1, "sk-ant-test"), "truthy non-boolean enablement closes gate");
ok(!canUseLinkedInBroker("v5", true, "   "), "blank key closes gate");
ok(!canUseLinkedInBroker("v5", true, { key: "sk-ant-test" }), "non-string key closes gate");

const validScore = {
  type: "LI_SCORE_POSTS",
  posts: [
    { i: 0, author: "Jane Doe", text: "A concrete observation.", context: "Reposted context.", meta: "Visible feed post.", authorHeadline: "Product leader at Acme", authorKind: "person", connectionDegree: "2nd" },
    { i: 1, author: "Acme", text: "A second observation." },
  ],
};
eq(sanitizeLinkedInScorePayload(validScore), validScore, "valid scoring payload is preserved");
eq(sanitizeLinkedInBrokerPayload(validScore), validScore, "canonical broker accepts scoring shape");

const tenPosts = Array.from({ length: LI_SCORE_MAX_BATCH }, (_, i) => ({ i, author: `Author ${i}`, text: `Post ${i}` }));
ok(sanitizeLinkedInScorePayload({ type: "LI_SCORE_POSTS", posts: tenPosts }) !== null, "maximum score batch passes");
ok(sanitizeLinkedInScorePayload({ type: "LI_SCORE_POSTS", posts: [...tenPosts, { i: 10, author: "Extra", text: "Extra" }] }) === null, "oversized score batch is rejected");
ok(sanitizeLinkedInScorePayload({ ...validScore, posts: [] }) === null, "empty score batch is rejected");
ok(sanitizeLinkedInScorePayload({ ...validScore, platform: "linkedin" }) === null, "legacy ambiguous platform field is rejected");
ok(sanitizeLinkedInScorePayload({ ...validScore, posts: [{ i: 1, author: "Jane", text: "Wrong index" }] }) === null, "non-canonical score indices are rejected");
ok(sanitizeLinkedInScorePayload({ ...validScore, posts: [{ i: 0, author: "Jane", text: "x".repeat(LI_PAYLOAD_LIMITS.text + 1) }] }) === null, "oversized post text is rejected");
ok(sanitizeLinkedInScorePayload({ ...validScore, posts: [{ i: 0, author: "", text: "Post" }] }) === null, "blank author is rejected");
ok(sanitizeLinkedInScorePayload({ ...validScore, posts: [{ i: 0, author: "Jane", text: "Post", steer: "cross-shape" }] }) === null, "draft-only fields are rejected in score posts");
ok(sanitizeLinkedInScorePayload({ ...validScore, posts: [{ i: 0, author: "Jane", text: "Post", authorHeadline: "x".repeat(LI_PAYLOAD_LIMITS.authorHeadline + 1) }] }) === null, "oversized visible headline is rejected");
ok(sanitizeLinkedInScorePayload({ ...validScore, posts: [{ i: 0, author: "Jane", text: "Post", authorKind: "celebrity" }] }) === null, "invented author-kind labels are rejected");
ok(sanitizeLinkedInScorePayload({ ...validScore, extra: true }) === null, "unknown scoring root fields are rejected");

const validDraft = {
  type: "LI_DRAFT_COMMENT",
  author: "Jane Doe",
  text: "A concrete observation.",
  context: "Reposted context.",
  reason: "Relevant operator lesson",
  category: "contribute",
  anchor: "The post's concrete claim",
  replyMove: "counterpoint",
  replyBrief: "Add one grounded caveat.",
  steer: "Make the caveat warmer.",
  currentDraft: "A first version to revise.",
  personalDetail: "I owned this handoff for six months.\nThe failure point was approval latency.",
  opportunityLine: "Write a self-contained LinkedIn comment.",
  authorHeadline: "Product leader at Acme",
  authorKind: "person",
  connectionDegree: "2nd",
  personReason: "Visible product leader matches target",
  commentLane: "boundary_condition",
};
eq(sanitizeLinkedInDraftPayload(validDraft), validDraft, "valid draft payload is preserved");
eq(sanitizeLinkedInBrokerPayload(validDraft), validDraft, "canonical broker accepts draft shape");
ok(sanitizeLinkedInDraftPayload({ ...validDraft, type: "LI_SCORE_POSTS" }) === null, "score message cannot cross into draft shape");
ok(sanitizeLinkedInDraftPayload({ ...validDraft, platform: "linkedin" }) === null, "legacy ambiguous platform field is rejected");
ok(sanitizeLinkedInDraftPayload({ ...validDraft, posts: validScore.posts }) === null, "score-only fields are rejected in draft payload");
ok(sanitizeLinkedInDraftPayload({ ...validDraft, steer: "x".repeat(LI_PAYLOAD_LIMITS.steer + 1) }) === null, "oversized draft field is rejected");
ok(sanitizeLinkedInDraftPayload({ ...validDraft, personalDetail: "x".repeat(LI_PAYLOAD_LIMITS.personalDetail + 1) }) === null, "oversized transient personal detail is rejected");
ok(sanitizeLinkedInDraftPayload({ ...validDraft, reason: 42 }) === null, "malformed draft field is rejected");
ok(sanitizeLinkedInDraftPayload({ ...validDraft, commentLane: "flattery" }) === null, "unknown contribution lanes are rejected at the broker boundary");
ok(sanitizeLinkedInDraftPayload({ ...validDraft, text: "Contains\u0000control" }) === null, "control characters are rejected");
eq(sanitizeLinkedInDraftPayload({ ...validDraft, context: "  Reposted\n context.  ", steer: "   " }),
  { ...validDraft, context: "Reposted context.", steer: undefined }, "optional text is normalized and blank optional fields are dropped");
ok(sanitizeLinkedInDraftPayload(validDraft)?.personalDetail.includes("\n"), "transient personal detail preserves meaningful line breaks");
ok(sanitizeLinkedInBrokerPayload({ type: "DRAFT_DM" }) === null, "unrecognized broker action is rejected");
ok(sanitizeLinkedInBrokerPayload(null) === null, "non-object broker payload is rejected");

console.log(fail === 0 ? `\n✓ LinkedIn policy: ${pass} assertions passed` : `\n✗ LinkedIn policy: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
