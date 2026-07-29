/** Unit tests for exact, durable completed-exchange memory. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/relationship-memory.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const NOW = Date.UTC(2026, 6, 19), DAY = 86_400_000;

const inbound = [
  { handle: "@Sam", kind: "reply", postId: "parent-1" },
  { handle: "sam", kind: "reply", postId: "parent-2" },
  { handle: "lee", kind: "mention", postId: "mention-1" },
];
let r = m.foldCompletedExchanges(undefined, "@Owner", inbound, { "parent-1": NOW - 15 * DAY, "parent-2": NOW - DAY, "mention-1": NOW }, NOW);
ok(r.changed, "exact answered parent ids fold into memory");
let ev = m.connectionEvidence(r.store, "owner", "SAM", NOW);
ok(ev?.completed === 2 && ev.activeWeeks === 2 && ev.established, "two exact exchanges across weeks establish an ongoing connection");
ok(!m.connectionEvidence(r.store, "owner", "lee", NOW), "mentions never count as completed reply exchanges");

const once = m.foldCompletedExchanges(r.store, "owner", inbound, { "parent-1": NOW - 15 * DAY, "parent-2": NOW - DAY }, NOW);
ok(!once.changed && once.store.owners.owner.accounts.sam, "reprocessing is idempotent");
const wrong = m.foldCompletedExchanges(undefined, "owner", [{ handle: "sam", kind: "reply", postId: "other" }], { "parent-1": NOW }, NOW);
ok(!wrong.store.owners.owner, "same handle without exact parent match gets no credit");

const oneWeek = m.foldCompletedExchanges(undefined, "owner", [{ handle: "sam", kind: "reply", postId: "a" }, { handle: "sam", kind: "reply", postId: "b" }], { a: NOW - DAY, b: NOW - 2 * DAY }, NOW).store;
ev = m.connectionEvidence(oneWeek, "owner", "sam", NOW);
ok(ev?.completed === 2 && ev.activeWeeks === 1 && !ev.established, "multiple exchanges in one week do not mint a long-term label");

const otherOwner = m.foldCompletedExchanges(undefined, "other", [{ handle: "sam", kind: "reply", postId: "x" }], { x: NOW }, NOW).store;
const merged = m.mergeRelationshipMemory(r.store, otherOwner, NOW);
ok(merged.owners.owner.accounts.sam && merged.owners.other.accounts.sam, "owner buckets do not bleed across X accounts");
ok(m.connectionEvidence(merged, "owner", "sam", NOW)?.completed === 2, "cross-tab merge unions without double counting");

const old = m.foldCompletedExchanges(undefined, "owner", [{ handle: "old", kind: "reply", postId: "z" }], { z: NOW - 366 * DAY }, NOW).store;
ok(!old.owners.owner, "exchanges older than a year are pruned");
const future = m.foldCompletedExchanges(undefined, "owner", [{ handle: "time", kind: "reply", postId: "f" }], { f: NOW + DAY }, NOW).store;
ok(!future.owners.owner, "future completion times are rejected");
ok(!JSON.stringify(merged).includes("reply text"), "memory stores identifiers and times, never notification text");

console.log(fail === 0 ? `\n✓ relationship memory: ${pass} assertions passed` : `\n✗ relationship memory: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
