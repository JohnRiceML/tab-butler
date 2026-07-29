/** Unit tests for exact Post Idea -> real X post attribution. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/idea-outcomes.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const NOW = 1_700_000_000_000, HR = 3_600_000;
const idea = (extra = {}) => ({ id: "i1", text: "Shipping faster got easier when I stopped treating every feature like a launch.", status: "working", createdAt: NOW - 2 * HR, ...extra });
const post = (extra = {}) => ({ id: "p1", text: "Shipping faster got easier when I stopped treating every feature like a launch.", postedAt: NOW - HR, views: 1200, likes: 31, replies: 4, reposts: 2, ...extra });

ok(m.normalizePublishedText(" Curly “quote”\nhttps://t.co/a ") === 'curly "quote"', "transport-only typography, links, and whitespace normalize");

let r = m.reconcileIdeaPublications([idea()], [post()], NOW);
ok(r.changed && r.matched === 1 && r.ideas[0].status === "posted", "unique exact match auto-moves a working idea to posted");
ok(r.ideas[0].publication.postId === "p1" && r.ideas[0].publication.views === 1200, "match stores real post id and X metrics");
ok(r.ideas[0].postedAt === NOW - HR && r.ideas[0].publication.confidence === "exact", "real publish time and confidence are explicit");

r = m.reconcileIdeaPublications(r.ideas, [post({ views: 2400, likes: 40 })], NOW + HR);
ok(r.changed && r.updated === 1 && r.matched === 0, "existing attribution refreshes metrics without rematching");
ok(r.ideas[0].publication.views === 2400 && r.ideas[0].publication.matchedAt === NOW, "refresh preserves original match time");

r = m.reconcileIdeaPublications(r.ideas, [], NOW + 2 * HR);
ok(!r.changed && r.ideas[0].publication.views === 2400, "last measurement survives after post rolls out of cache");

r = m.reconcileIdeaPublications([idea()], [post({ text: "Shipping faster became easier after I simplified launches." })], NOW);
ok(!r.changed, "fuzzy or edited text is never guessed");
r = m.reconcileIdeaPublications([idea(), { ...idea(), id: "i2" }], [post()], NOW);
ok(!r.changed, "duplicate idea text is ambiguous and stays unmatched");
r = m.reconcileIdeaPublications([idea()], [post(), post({ id: "p2", postedAt: NOW - 30_000 })], NOW);
ok(!r.changed, "repeated real post text is ambiguous and stays unmatched");
r = m.reconcileIdeaPublications([idea()], [post({ postedAt: NOW - 3 * HR })], NOW);
ok(!r.changed, "a post predating idea creation cannot be claimed");
r = m.reconcileIdeaPublications([idea()], [post({ postedAt: undefined })], NOW);
ok(!r.changed, "a post without a real publish timestamp cannot be claimed");
r = m.reconcileIdeaPublications([idea({ text: "Too short" })], [post({ text: "Too short" })], NOW);
ok(!r.changed, "short collisions are ignored");

const already = r.ideas;
const two = m.reconcileIdeaPublications(
  [idea(), { ...idea({ id: "i2", text: "A distinct second idea with enough exact words to be safely matched.", createdAt: NOW - HR }) }],
  [post(), post({ id: "p2", text: "A distinct second idea with enough exact words to be safely matched.", postedAt: NOW - 30_000 })], NOW,
);
ok(two.matched === 2 && new Set(two.ideas.map((i) => i.publication?.postId)).size === 2, "distinct exact pairs reconcile independently");
ok(Array.isArray(already), "inputs without a match remain valid records");

console.log(fail === 0 ? `\n✓ idea outcomes: ${pass} assertions passed` : `\n✗ idea outcomes: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
