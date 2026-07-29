/**
 * Unit tests for draft-and-remind scheduling (schedule.ts). Bundled with esbuild
 * (schedule.ts imports POST_SPACING_MINS from momentum.ts) + imported from a data
 * URL. Run: node scripts/test-schedule.mjs
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const built = esbuild.buildSync({ entryPoints: [join(here, "../src/lib/schedule.ts")], bundle: true, write: false, format: "esm", platform: "node" });
const m = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const { nextShipSlots, reminderState, dueReminderCount, reminderToastLine, formatSlot, REMIND_OVERDUE_MINS } = m;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const eq = (a, b, l) => { if (a === b) pass++; else { fail++; console.error("  FAIL:", l, "got", a, "want", b); } };

const MIN = 60_000, HR = 3_600_000;
const SPACING_MS = 180 * MIN; // POST_SPACING_MINS — momentum.ts owns the constant
// Local-time construction keeps the day-part math timezone-independent for the suite.
const NOW = new Date(2026, 6, 29, 10, 0, 0, 0).getTime(); // a 10:00 am local morning

// ---- nextShipSlots: spacing since the last own post is respected ----
{
  const slots = nextShipSlots({ now: NOW, minsSinceLastOwnPost: 30, queue: [] });
  ok(slots.length === 3, "returns 3 suggestions by default");
  ok(slots.every((s) => s.at >= NOW + 150 * MIN), "every slot clears the remaining 150 min of the ~3h spacing prior");
  ok(slots[0].at <= NOW + 155 * MIN, "first slot is the EARLIEST spaced moment (rounded up ≤5 min)");
  ok(/spacing prior/.test(slots[0].note) && !/best time/i.test(slots[0].note), "spacing slot is narrated as a prior, no best-time claim");
}
// ---- no recent own post: day-part priors only, never a useless "now" ----
{
  const slots = nextShipSlots({ now: NOW, minsSinceLastOwnPost: 500, queue: [] });
  ok(slots.length === 3, "well-spaced user still gets 3 slots");
  ok(slots.every((s) => s.at >= NOW + 15 * MIN), "no slot lands inside the 15-min lead floor");
  const first = new Date(slots[0].at);
  ok(first.getHours() === 12 && first.getMinutes() === 30, "first day-part after 10 am is 12:30 pm local");
  ok(slots.every((s) => s.prior === true), "every suggestion is labeled a prior (the UI shows ✦)");
  ok(slots.every((s) => /prior/i.test(s.note) && !/best time to post|25-40%/i.test(s.note)), "notes say prior and never fabricate a benchmark");
}
// ---- unknown last-post time: no spacing hold is invented ----
{
  const slots = nextShipSlots({ now: NOW, queue: [] });
  ok(slots.length === 3 && slots[0].at >= NOW + 15 * MIN, "unknown spacing -> day-parts from the lead floor, no fabricated hold");
}
// ---- suggestions stay clear of OTHER scheduled reminders and of each other ----
{
  const reserved = NOW + 150 * MIN; // 12:30 pm already booked by another draft
  const slots = nextShipSlots({ now: NOW, minsSinceLastOwnPost: 500, queue: [{ id: "other", status: "working", remindAt: reserved }] });
  ok(slots.every((s) => Math.abs(s.at - reserved) >= SPACING_MS), "slots keep ~3h clear of another draft's reminder");
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++)
    ok(Math.abs(slots[i].at - slots[j].at) >= SPACING_MS, `slots ${i}/${j} are mutually spaced ~3h+`);
}
// ---- the idea being rescheduled must not block itself ----
{
  const withSelf = nextShipSlots({ now: NOW, minsSinceLastOwnPost: 500, queue: [{ id: "me", status: "working", remindAt: NOW + 150 * MIN }], excludeId: "me" });
  const noQueue = nextShipSlots({ now: NOW, minsSinceLastOwnPost: 500, queue: [] });
  eq(withSelf[0].at, noQueue[0].at, "excludeId frees the idea's own current reminder window");
}
// ---- posted drafts' stale remindAt values reserve nothing ----
{
  const slots = nextShipSlots({ now: NOW, minsSinceLastOwnPost: 500, queue: [{ id: "p", status: "posted", remindAt: NOW + 150 * MIN }] });
  const first = new Date(slots[0].at);
  ok(first.getHours() === 12 && first.getMinutes() === 30, "a posted idea's leftover remindAt does not block the 12:30 slot");
}

// ---- reminderState transitions ----
const idea = (remindAt, extra = {}) => ({ id: "i1", status: "working", remindAt, ...extra });
eq(reminderState(undefined, NOW), "none", "no idea -> none");
eq(reminderState({ id: "x", status: "working" }, NOW), "none", "no remindAt -> none");
eq(reminderState(idea(NOW + HR), NOW), "scheduled", "future remindAt -> scheduled");
eq(reminderState(idea(NOW - 5 * MIN), NOW), "due", "just past remindAt -> due");
eq(reminderState(idea(NOW - (REMIND_OVERDUE_MINS + 1) * MIN), NOW), "overdue", "an hour past -> overdue");
eq(reminderState({ id: "x", status: "posted", remindAt: NOW - HR }, NOW), "none", "posted drafts never remind");

// ---- dueReminderCount: badge math, tolerant of raw storage ----
eq(dueReminderCount(undefined, NOW), 0, "missing storage value -> 0");
eq(dueReminderCount("junk", NOW), 0, "non-array storage value -> 0");
eq(dueReminderCount([null, 42, { id: "a" }], NOW), 0, "junk entries count nothing");
eq(dueReminderCount([idea(NOW - 5 * MIN), idea(NOW - 2 * HR), idea(NOW + HR)], NOW), 2, "due + overdue count; scheduled does not");
eq(dueReminderCount([{ id: "p", status: "posted", remindAt: NOW - HR }], NOW), 0, "posted never badges");
ok(dueReminderCount([idea(NOW - 5 * MIN, { remindedAt: NOW - 4 * MIN })], NOW) === 1, "an already-toasted reminder still badges until acted on");

// ---- reminderToastLine: honest copy, spacing note only when relevant ----
{
  const line = reminderToastLine("Shipping faster got easier when I stopped treating every feature like a launch.\nSecond line.", 500);
  ok(line.includes("Shipping faster got easier"), "toast quotes the draft's first line");
  ok(/your click/i.test(line), "toast states posting stays the user's click");
  ok(!/spacing prior/.test(line), "well-spaced -> no spacing note");
}
{
  const line = reminderToastLine("A draft.", 30);
  ok(/spacing prior/.test(line) && /never a block/i.test(line), "recent own post -> soft spacing note, never a block");
  ok(/150 min|~2h/.test(line), "spacing note reuses postSpacingNudge's remaining-minutes output");
  ok(!/best time/i.test(line), "no best-time claim in reminder copy");
}
{
  const long = "x".repeat(120);
  ok(reminderToastLine(long).includes("…"), "long drafts are snipped");
  ok(reminderToastLine("").includes("your draft"), "empty text falls back gracefully");
}

// ---- formatSlot labels (built with local dates, so tz-safe) ----
eq(formatSlot(new Date(2026, 6, 29, 17, 30).getTime(), NOW), "Today 5:30 pm", "same-day label");
eq(formatSlot(new Date(2026, 6, 30, 9, 0).getTime(), NOW), "Tomorrow 9:00 am", "next-day label");
ok(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 12:30 pm$/.test(formatSlot(new Date(2026, 7, 1, 12, 30).getTime(), NOW)), "farther out -> weekday label");
eq(formatSlot(new Date(2026, 6, 30, 0, 5).getTime(), NOW), "Tomorrow 12:05 am", "midnight renders as 12:05 am");

if (fail) { console.error(`test-schedule: ${fail} failed, ${pass} passed`); process.exit(1); }
console.log(`test-schedule: ${pass} passed`);
