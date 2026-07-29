/**
 * Draft-and-remind scheduling for post ideas — pure (no DOM, no chrome.*), unit-tested
 * (scripts/test-schedule.mjs).
 *
 * What this is: the user picks a time to be NUDGED about a draft they already wrote.
 * Nothing here posts, opens a composer, or acts on its own — the content script
 * highlights the idea + toasts, the service worker sets the toolbar badge count, and
 * every next step is a user click on the existing ship path. Draft-only is the brand.
 *
 * Honesty rules baked in:
 *  - Suggested slots respect POST_SPACING_MINS (imported from momentum.ts — single
 *    source of truth, itself a product prior) against BOTH the user's last own post
 *    and every other scheduled reminder, so accepting suggestions keeps originals spaced.
 *  - The day-part picks are PRIORS (✦): commonly used posting windows, never a claimed
 *    "best time to post" — no fabricated benchmark exists here and none may be added.
 *  - Reminder copy reuses postSpacingNudge's soft output when spacing is relevant;
 *    it is a note, never a block.
 */
import { POST_SPACING_MINS, postSpacingNudge } from "./momentum";

/** The slice of IdeaRecord this module needs (x-copilot's IdeaRecord satisfies it). */
export interface ScheduledIdeaLite {
  id?: string;
  status?: string;             // only "working" drafts carry live reminders
  remindAt?: number;           // when the user asked to be nudged
  remindedAt?: number;         // when the one-shot toast fired (chip stays until acted on)
}

export interface SlotSuggestion {
  at: number;      // epoch ms
  label: string;   // "Today 5:30 pm" / "Tomorrow 9:00 am" / "Thu 12:30 pm"
  prior: boolean;  // always true today — every suggestion is a prior, and the UI shows ✦
  note: string;    // hover copy stating exactly what the suggestion is (and isn't)
}

/** Past this long after remindAt, the chip escalates from "due" to "overdue". */
export const REMIND_OVERDUE_MINS = 60;
/** Suggestions never land closer than this — a reminder "in 2 minutes" is noise. */
const MIN_LEAD_MS = 15 * 60_000;
const SPACING_MS = POST_SPACING_MINS * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Common posting windows (local time). A prior, not a measured best time. */
const DAY_PARTS: Array<[hour: number, minute: number]> = [[9, 0], [12, 30], [17, 30]];
const DAY_PART_NOTE =
  "✦ Prior: a commonly used posting window, not a measured best time for your account. " +
  "Spaced ~3h+ from your other scheduled drafts.";

function clock(d: Date): string {
  let h = d.getHours();
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
}

/** Compact local-time label relative to now: Today / Tomorrow / weekday. */
export function formatSlot(at: number, now: number): string {
  const d = new Date(at);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, new Date(now))) return `Today ${clock(d)}`;
  if (sameDay(d, new Date(now + DAY_MS))) return `Tomorrow ${clock(d)}`;
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${clock(d)}`;
}

export interface SlotInput {
  now: number;
  /** Minutes since the user's last OWN original post; undefined = unknown (no spacing hold). */
  minsSinceLastOwnPost?: number;
  /** The full idea queue — other working drafts' remindAt values are reserved windows. */
  queue: ScheduledIdeaLite[];
  /** The idea being (re)scheduled — its own current remindAt must not block the picker. */
  excludeId?: string;
  count?: number;
}

/**
 * Suggest the next ship slots: (optionally) the earliest moment that clears the
 * ~3h spacing prior since the user's last original, then upcoming day-part windows.
 * Every accepted suggestion also stays POST_SPACING_MINS clear of other scheduled
 * reminders AND of earlier suggestions, so taking all of them keeps originals spaced.
 */
export function nextShipSlots(input: SlotInput): SlotSuggestion[] {
  const { now, queue, excludeId } = input;
  const count = input.count ?? 3;
  const nudge = postSpacingNudge(input.minsSinceLastOwnPost);
  const earliest = now + (nudge ? nudge.minsToGo * 60_000 : 0);
  const reserved = (Array.isArray(queue) ? queue : [])
    .filter((i) => i && i.status === "working" && i.id !== excludeId && typeof i.remindAt === "number" && (i.remindAt as number) > now - SPACING_MS)
    .map((i) => i.remindAt as number);

  const out: SlotSuggestion[] = [];
  const clearOf = (at: number) => reserved.every((r) => Math.abs(at - r) >= SPACING_MS) && out.every((s) => Math.abs(at - s.at) >= SPACING_MS);
  const push = (at: number, note: string) => out.push({ at, label: formatSlot(at, now), prior: true, note });

  // Slot 1, only when spacing is actually binding: the earliest spaced moment (rounded to 5 min).
  if (nudge) {
    const at = Math.ceil(Math.max(earliest, now + MIN_LEAD_MS) / 300_000) * 300_000;
    if (clearOf(at)) push(at, "✦ Earliest slot that clears the ~3h-between-originals spacing prior since your last post. A prior, not a promise — you can always post sooner.");
  }
  // Then day-part windows, scanning up to a few days out.
  for (let day = 0; day < 4 && out.length < count; day++) {
    for (const [h, m] of DAY_PARTS) {
      if (out.length >= count) break;
      const d = new Date(now + day * DAY_MS);
      d.setHours(h, m, 0, 0);
      const at = d.getTime();
      if (at < earliest || at < now + MIN_LEAD_MS || !clearOf(at)) continue;
      push(at, DAY_PART_NOTE);
    }
  }
  return out.slice(0, count);
}

export type ReminderState = "none" | "scheduled" | "due" | "overdue";

/** Where one draft's reminder stands right now. Posted drafts never remind. */
export function reminderState(idea: ScheduledIdeaLite | undefined, now: number): ReminderState {
  if (!idea || idea.status !== "working" || typeof idea.remindAt !== "number") return "none";
  if (now < idea.remindAt) return "scheduled";
  return now - idea.remindAt >= REMIND_OVERDUE_MINS * 60_000 ? "overdue" : "due";
}

/** Due + overdue working drafts — the toolbar badge count. Tolerant of raw storage
 *  values (the service worker feeds it chrome.storage reads unvalidated). */
export function dueReminderCount(queue: unknown, now: number): number {
  if (!Array.isArray(queue)) return 0;
  let n = 0;
  for (const i of queue as ScheduledIdeaLite[]) {
    const s = reminderState(i, now);
    if (s === "due" || s === "overdue") n++;
  }
  return n;
}

/**
 * The one-shot toast line when a reminder comes due. Mentions spacing ONLY when it is
 * actually relevant (reuses postSpacingNudge — soft, never blocking), and never claims
 * a best time or predicts an outcome.
 */
export function reminderToastLine(text: string, minsSinceLastOwnPost?: number): string {
  const first = (text || "").split("\n").map((l) => l.trim()).find(Boolean) || "your draft";
  const snip = first.length > 64 ? first.slice(0, 63).trimEnd() + "…" : first;
  const base = `⏰ Draft reminder: “${snip}” — it's highlighted in your Ideas tab. Posting stays your click.`;
  const nudge = postSpacingNudge(minsSinceLastOwnPost);
  if (!nudge) return base;
  const wait = nudge.minsToGo < 60 ? `${nudge.minsToGo} min` : `~${Math.floor(nudge.minsToGo / 60)}h`;
  return `${base} Soft note: your last original is recent — ${wait} more would clear the ~3h spacing prior. Your call, never a block.`;
}
