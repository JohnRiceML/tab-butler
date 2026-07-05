/**
 * Unit test for the gamified-but-honest activity layer (activity.ts). esbuild → data-URL import.
 * Run: node scripts/test-activity.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/activity.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const dk = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const dayAgo = (n) => dk(NOW - n * DAY);

// ---- activityCells: measured dots, oldest → newest ----
{
  const cells = m.activityCells({ [dayAgo(0)]: 2, [dayAgo(1)]: 9 }, { [dayAgo(1)]: 1, [dayAgo(3)]: 1 }, NOW, dk, 7);
  ok(cells.length === 7 && cells[6].day === dayAgo(0) && cells[0].day === dayAgo(6), "7 cells, oldest first, today last");
  ok(cells[6].intensity === 1 && cells[6].replies === 2, "2 acts → intensity 1");
  ok(cells[5].intensity === 3 && cells[5].posts === 1, "10 acts (9 replies + 1 post) → intensity 3");
  ok(cells[3].active === true && cells[3].intensity === 1, "a post-only day counts as active");
  ok(cells[4].active === false && cells[4].intensity === 0, "an empty day is honestly empty");
}

// ---- chain: today's grace, best run ----
{
  const active = (days) => Object.fromEntries(days.map((n) => [dayAgo(n), 1]));
  const c1 = m.chain(m.activityCells(active([1, 2, 3]), {}, NOW, dk, 14));
  ok(c1.current === 3, "inactive-so-far today doesn't break the chain (grace)");
  const c2 = m.chain(m.activityCells(active([0, 1, 2]), {}, NOW, dk, 14));
  ok(c2.current === 3, "active today extends the chain");
  const c3 = m.chain(m.activityCells(active([1, 2, 4, 5, 6, 7]), {}, NOW, dk, 14));
  ok(c3.current === 2 && c3.best === 4, "a gap breaks current; best remembers the longest run");
  const c4 = m.chain(m.activityCells({}, {}, NOW, dk, 14));
  ok(c4.current === 0 && c4.best === 0, "no activity → zero, never invented");
}

// ---- pickCallout: safety first, then measured trend, then the algo-backed nudges ----
{
  const base = { easeoff: false, trend: null, chainDays: 3, repliesToday: 2, postsThisWeek: 1 };
  ok(m.pickCallout({ ...base, easeoff: true, trend: "picking-up" }).text.includes("Ease off"), "easeoff beats everything — the flame never cheers past the line");
  ok(m.pickCallout({ ...base, trend: "cooling" }).kind === "measured", "cooling callout is labeled measured");
  ok(m.pickCallout({ ...base, trend: "picking-up" }).text.includes("working"), "picking-up celebrates without pushing volume");
  ok(m.pickCallout({ ...base, repliesToday: 0 }).text.includes("Show up"), "inactive today → the affinity-compounding nudge");
  ok(m.pickCallout({ ...base, postsThisWeek: 0 }).text.includes("original"), "no posts this week → the funnel-mix nudge");
  ok(m.pickCallout(base).text.includes("Reply early"), "default → the timing lever");
  const all = [m.pickCallout(base), m.pickCallout({ ...base, easeoff: true })];
  ok(all.every((c) => c.why && (c.kind === "prior" || c.kind === "measured")), "every callout names its evidence class (honest-mirror)");
  ok(!JSON.stringify(all).toLowerCase().includes("streak bonus"), "no callout claims a literal streak bonus");
}

console.log(fail === 0 ? `\n✓ activity: ${pass} assertions passed` : `\n✗ activity: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
