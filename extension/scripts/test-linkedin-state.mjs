/** Unit tests for deterministic, concurrent-safe LinkedIn comment activity state. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/linkedin-state.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (condition, label) => {
  if (condition) pass += 1;
  else { fail += 1; console.error("  FAIL:", label); }
};
const entry = (postId, postedAt, author = postId) => ({
  postId,
  author,
  permalink: `https://www.linkedin.com/feed/update/${postId}?tracking=nope#comments`,
  postedAt,
});

// Malformed/current legacy inputs normalize without consulting the wall clock.
{
  const legacy = {
    version: 1,
    total: "9",
    entries: [
      null,
      {},
      { postId: "  p-1  ", author: "  Ada   Lovelace ", authorKey: "/IN/Ada-Lovelace/", postedAt: "10", permalink: "https://www.linkedin.com/feed/update/p-1?trk=x" },
      { postId: "p-1", author: "Older duplicate", postedAt: 2 },
      { id: "p-2", author: null, at: "not-a-date", url: "https://evil.example/posts/nope" },
      { postId: { nope: true }, author: "invalid", postedAt: 20 },
    ],
  };
  const log = m.normalizeCommentLog(legacy);
  ok(log.version === 3 && log.total === 9, "v1 shape migrates to v3 and preserves its declared lifetime total");
  ok(log.entries.length === 2 && log.entries[0].postId === "p-1", "malformed rows are dropped and duplicate post IDs dedupe to the newest event");
  ok(log.entries[0].author === "Ada Lovelace" && !log.entries[0].permalink.includes("?"), "canonical rows clean text and tracking parameters");
  ok(log.entries[0].authorKey === "/in/ada-lovelace", "visible profile path is normalized as a local author-spacing key");
  ok(log.entries[1].author === "LinkedIn member" && log.entries[1].postedAt === 0 && !log.entries[1].permalink, "legacy aliases and deterministic invalid-field fallbacks are supported");
  ok(log.pending.length === 0 && log.dismissed.length === 0, "v1 logs migrate with an empty review lifecycle");
  ok(m.serializeCommentLog(log) === m.serializeCommentLog(m.normalizeCommentLog(log)), "normalization and serialization are idempotent");

  const arrayLog = m.normalizeCommentLog([entry("array", 11)]);
  const v2Log = m.normalizeCommentLog({ version: 2, total: 4, entries: [entry("v2", 12)], removed: [] });
  ok(arrayLog.version === 3 && arrayLog.total === 1 && arrayLog.pending.length === 0, "legacy array storage migrates to canonical v3");
  ok(v2Log.version === 3 && v2Log.total === 4 && v2Log.pending.length === 0, "v2 storage migrates to canonical v3 without changing confirmed total");
}

// Review handoffs persist separately from confirmed activity and re-copy in place.
{
  let log = m.startCommentReview(undefined, {
    postId: "review-1",
    author: "  Grace   Hopper ",
    permalink: "https://www.linkedin.com/feed/update/review-1?trk=copy",
    copiedAt: 10,
  });
  ok(log.total === 0 && log.entries.length === 0 && log.pending.length === 1, "copy starts one persistent review without claiming a confirmation");
  ok(log.pending[0].author === "Grace Hopper" && log.pending[0].copyCount === 1 && log.pending[0].copiedAt === 10, "review metadata is canonical and records its first copy");

  log = m.startCommentReview(log, { postId: "review-1", author: "Grace Hopper", copiedAt: 20 });
  ok(log.pending.length === 1 && log.pending[0].copyCount === 2, "re-copy refreshes one row instead of duplicating pending state");
  ok(log.pending[0].copiedAt === 10 && log.pending[0].lastCopiedAt === 20, "re-copy preserves first-copy and latest-copy timestamps");
  const retried = m.startCommentReview(log, { postId: "review-1", author: "Grace Hopper", copiedAt: 20 });
  ok(m.commentLogsEqual(retried, log), "replaying the same copy event is idempotent");

  const normalized = m.normalizeCommentLog({
    version: 3,
    total: 0,
    pending: [
      { postId: "dupe", author: "Old", copiedAt: 1, lastCopiedAt: 2, copyCount: 1 },
      { postId: "dupe", author: "New", copiedAt: 1, lastCopiedAt: 3, copyCount: 2 },
    ],
  });
  ok(normalized.pending.length === 1 && normalized.pending[0].author === "New" && normalized.pending[0].copyCount === 2, "malformed duplicate pending rows normalize deterministically");
}

// Confirmation is the only review transition that increments total, and it is idempotent.
{
  const review = m.startCommentReview(undefined, { postId: "confirm", author: "Ada", copiedAt: 10 });
  const confirmed = m.confirmCommentPosted(review, entry("confirm", 20, "Ada"));
  ok(confirmed.total === 1 && confirmed.entries.length === 1 && confirmed.pending.length === 0, "confirm atomically moves a review into confirmed activity");
  const repeated = m.markCommentPosted(confirmed, entry("confirm", 21, "Ada"));
  ok(repeated.total === 1 && repeated.pending.length === 0, "repeated same-post confirmation does not increment twice or recreate pending state");
  const staleMerge = m.mergeCommentLogs(review, confirmed);
  ok(staleMerge.total === 1 && staleMerge.pending.length === 0, "a confirmed active entry wins over a stale pending copy during merge");
}

// Dismissal leaves confirmed totals alone, survives stale merges, and permits a later re-copy.
{
  const pending = m.startCommentReview(undefined, { postId: "dismiss", author: "Lin", copiedAt: 10 });
  const dismissed = m.dismissCommentReview(pending, "dismiss", 20);
  ok(dismissed.total === 0 && dismissed.pending.length === 0 && dismissed.dismissed.length === 1, "dismiss removes review metadata without touching confirmed total");
  const replayed = m.mergeCommentLogs(pending, dismissed);
  ok(replayed.pending.length === 0 && replayed.total === 0, "dismissal marker prevents a stale tab from resurrecting pending review");
  const recopied = m.startCommentReview(replayed, { postId: "dismiss", author: "Lin", copiedAt: 30 });
  ok(recopied.pending.length === 1 && recopied.pending[0].lastCopiedAt === 30, "a genuinely later copy supersedes the older dismissal");
  ok(m.commentLogsEqual(m.dismissCommentReview(dismissed, "dismiss", 25), dismissed), "dismissing an already-absent review is idempotent");
}

// Concurrent pending changes converge deterministically.
{
  const base = m.startCommentReview(undefined, { postId: "shared", author: "Base", copiedAt: 10 });
  const recopy = m.startCommentReview(base, { postId: "shared", author: "New", copiedAt: 20 });
  const dismiss = m.dismissCommentReview(base, "shared", 21);
  const resolved = m.mergeCommentLogs(recopy, dismiss);
  ok(resolved.pending.length === 0, "a later concurrent dismissal wins over an earlier re-copy");

  const left = m.startCommentReview(base, { postId: "left-review", author: "Left", copiedAt: 30 });
  const right = m.startCommentReview(base, { postId: "right-review", author: "Right", copiedAt: 31 });
  const merged = m.mergeCommentLogs(left, right);
  ok(merged.pending.length === 3 && merged.total === 0, "different concurrent review handoffs union without affecting confirmed totals");
  ok(m.serializeCommentLog(merged) === m.serializeCommentLog(m.mergeCommentLogs(right, left)), "pending merge converges independent of writer order");
}

// Same-ID concurrent writes count once; different-ID concurrent writes count both.
{
  const base = m.markCommentPosted(undefined, entry("base", 10));
  const sameA = m.markCommentPosted(base, entry("same", 20, "Alpha"));
  const sameB = m.markCommentPosted(base, entry("same", 21, "Beta"));
  const same = m.mergeCommentLogs(sameA, sameB);
  ok(same.total === 2 && same.entries.filter((row) => row.postId === "same").length === 1, "two tabs marking the same post add exactly one lifetime event");
  ok(same.entries.find((row) => row.postId === "same")?.postedAt === 21, "same-post races deterministically retain the newest payload");

  const differentA = m.markCommentPosted(base, entry("left", 30));
  const differentB = m.markCommentPosted(base, entry("right", 31));
  const different = m.mergeCommentLogs(differentA, differentB);
  ok(different.total === 3 && different.entries.length === 3, "two tabs marking different posts retain both concurrent increments");
}

// Retention stays bounded while the lifetime total remains monotonic.
{
  let log;
  for (let index = 1; index <= 6; index += 1) log = m.addCommentLogEntry(log, entry(`p-${index}`, index), 3);
  ok(log.entries.length === 3 && log.total === 6, "entry pruning is bounded without reducing lifetime total");
  ok(log.entries.map((row) => row.postId).join(",") === "p-6,p-5,p-4", "the bounded window retains the newest deterministic rows");
  const narrower = m.normalizeCommentLog(log, 2);
  ok(narrower.entries.length === 2 && narrower.total === 6, "normalizing to a smaller retention cap cannot lower total");

  let stale;
  for (let index = 1; index <= 3; index += 1) stale = m.addCommentLogEntry(stale, entry(`s-${index}`, index), 3);
  const current = m.addCommentLogEntry(stale, entry("s-4", 4), 3);
  const merged = m.mergeCommentLogs(stale, current, 3);
  ok(merged.total === 4 && merged.entries.map((row) => row.postId).join(",") === "s-4,s-3,s-2", "a full stale retention window does not re-count a row pruned by the current writer");
}

// Ordering, merge direction, and object key output are deterministic.
{
  const left = { total: 2, entries: [entry("z", 50), entry("a", 50)] };
  const right = { entries: [entry("a", 50), entry("z", 50)], total: 2 };
  ok(m.commentLogsEqual(left, right), "equivalent unsorted shapes compare equal after canonicalization");
  ok(m.normalizeCommentLog(left).entries.map((row) => row.postId).join(",") === "a,z", "timestamp ties use stable post-ID ordering");

  const a = m.markCommentPosted(undefined, entry("a", 1));
  const b = m.markCommentPosted(undefined, entry("b", 2));
  ok(m.serializeCommentLog(m.mergeCommentLogs(a, b)) === m.serializeCommentLog(m.mergeCommentLogs(b, a)), "merge is commutative down to stable serialization");
}

// Undo is exact, corrects total once, and survives a later merge from a stale tab.
{
  let log = m.markCommentPosted(undefined, entry("one", 10));
  log = m.markCommentPosted(log, entry("two", 20));
  const stale = log;
  const wrong = m.undoLatestComment(log, { postId: "two", postedAt: 19 }, 30);
  ok(m.commentLogsEqual(wrong, log), "a stale/mismatched undo reference is a no-op");

  const undone = m.removeLatestCommentEntry(log, { postId: "two", postedAt: 20, author: "Two", copiedAt: 15, copyCount: 2 }, 30);
  ok(undone.total === 1 && !undone.entries.some((row) => row.postId === "two"), "an exact undo removes one event and corrects total once");
  ok(undone.pending[0]?.postId === "two" && undone.pending[0].author === "Two" && undone.pending[0].copyCount === 2, "undo atomically restores pending review metadata when the event supplies an author");
  const reconciled = m.mergeCommentLogs(stale, undone);
  ok(reconciled.total === 1 && !reconciled.entries.some((row) => row.postId === "two") && reconciled.pending[0]?.postId === "two", "the removal marker prevents stale confirmation while preserving restored review");

  const remarked = m.markCommentPosted(reconciled, entry("two", 40));
  ok(remarked.total === 2 && remarked.entries[0].postId === "two", "a later deliberate re-mark supersedes the older undo marker");
  const oldUndo = m.undoLatestComment(remarked, { postId: "two", postedAt: 20 }, 50);
  ok(m.commentLogsEqual(oldUndo, remarked), "an old undo reference cannot remove the newer re-mark");
}

// A stale state merged into a sequentially advanced state stays at the current total.
{
  const one = m.markCommentPosted(undefined, entry("one", 1));
  const current = m.markCommentPosted(m.markCommentPosted(one, entry("two", 2)), entry("three", 3));
  const merged = m.mergeCommentLogs(one, current);
  ok(merged.total === 3 && merged.entries.length === 3, "stale/current merge neither loses nor double-counts sequential additions");
  ok(m.commentLogsEqual(m.mergeCommentLogs(current, merged), current), "re-merging the reconciled state is stable");
}

console.log(fail === 0 ? `\n✓ LinkedIn state: ${pass} assertions passed` : `\n✗ LinkedIn state: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
