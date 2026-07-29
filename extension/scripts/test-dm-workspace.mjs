/** Unit tests for the local-first, draft-only DM workspace. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/dm-workspace.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };
const NOW = 1_800_000_000_000, DAY = 86_400_000;

let s = m.freshDmStore("Owner");
let a = m.addDmCandidate(s, "owner", { handle: "@Sam", source: "manual" }, NOW);
ok(!a.error && a.candidate.handle === "sam" && a.candidate.stage === "research", "manual add is canonical and starts in research");
s = a.store;
ok(m.addDmCandidate(s, "owner", { handle: "SAM", source: "target" }, NOW + 1).error, "same peer dedupes by canonical handle");
const enrichedExisting = m.addDmCandidate(s, "owner", { handle: "SAM", source: "reply_spot", context: [{ id: "new-post", kind: "public_post", source: "observed", text: "A newly selected public post", capturedAt: NOW + 2 }] }, NOW + 2);
ok(enrichedExisting.store.candidates[0].context.some((x) => x.id === "new-post"), "planning an existing person appends newly selected evidence instead of discarding it");
const switched = m.addDmCandidate(s, "other", { handle: "lee", source: "manual" }, NOW);
ok(switched.store.ownerHandle === "other" && switched.store.candidates.length === 1 && switched.store.candidates[0].handle === "lee", "owner switch resets instead of bleeding another account's state");
ok(m.addDmCandidate(s, "owner", { handle: "owner", source: "manual" }, NOW).error, "self account cannot be added");

let c = s.candidates[0];
ok(!m.canDraftDm(c, "first", NOW).ok, "uncontextualized cold first DM is blocked");
s = m.appendDmContext(s, "sam", "note", "user", "We both serve bootstrapped SaaS teams and could do a joint teardown.", NOW + 10);
c = s.candidates[0];
ok(!m.canDraftDm(c, "first", NOW + 10).ok && m.canMoveDmReady(c).ok, "specific context unlocks Ready but not a first draft while still in Research");
s = m.updateDmCandidate(s, "sam", { intent: "co_market", stage: "ready", draft: "Loved your teardown on onboarding. I have a complementary retention audit. Open to testing a joint teardown for small SaaS teams?" }, NOW + 20);
ok(m.canDraftDm(s.candidates[0], "first", NOW + 20).ok, "a validated Ready candidate can draft a first DM");
const badSponsor = { ...s.candidates[0], intent: "sponsor", goal: "I would like to send a generic commercial message", stage: "ready" };
ok(!m.canMoveDmReady(badSponsor).ok, "Sponsor requires a real sponsorship cue or specific sponsorship note");
s = m.markDmSent(s, "sam", s.candidates[0].draft, "first", NOW + 30);
c = s.candidates[0];
ok(c.stage === "waiting" && c.dueAt === NOW + 30 + 7 * DAY && c.touches.length === 1, "mark sent logs claimed touch and schedules seven-day follow-up");
ok(!c.draft && !c.draftPhase, "mark sent clears the working draft so it cannot be logged twice");
ok(!m.canDraftDm(c, "follow_up", NOW + 6 * DAY).ok && m.canDraftDm(c, "follow_up", NOW + 8 * DAY).ok, "follow-up cannot be drafted early");
ok(m.dueFollowUps(s, NOW + 8 * DAY).length === 1, "due queue surfaces waiting conversations");
s = m.markDmSent(s, "sam", "One useful add: I mocked a sample format based on that thread. Happy to send it if useful.", "follow_up", NOW + 8 * DAY);
ok(m.followUpCount(s.candidates[0]) === 1 && !m.canDraftDm(s.candidates[0], "follow_up", NOW + 20 * DAY).ok, "one unanswered follow-up maximum");
s = m.markDmReplied(s, "sam", "Yes, send it over.", NOW + 9 * DAY);
ok(s.candidates[0].stage === "active" && !s.candidates[0].dueAt && s.candidates[0].touches.at(-1).direction === "inbound", "manual reply starts conversation and cancels follow-up");
ok(m.followUpCount(s.candidates[0]) === 0, "an inbound reply closes the previous unanswered-follow-up episode");
const inboundId = s.candidates[0].touches.at(-1).id;
s = m.redactDmTouch(s, "sam", inboundId, NOW + 9 * DAY + 1);
ok(!s.candidates[0].touches.at(-1).text && s.candidates[0].stage === "active", "private message text can be removed without falsifying the manual reply marker");

let dupStore = m.freshDmStore("owner");
dupStore = m.addDmCandidate(dupStore, "owner", { handle: "a", source: "relationship", reasons: [{ id: "r", label: "exact ongoing connection with useful context", source: "measured", capturedAt: NOW }] }, NOW).store;
dupStore = m.markDmSent(dupStore, "a", "I liked your concrete onboarding teardown and have a useful retention example for the same audience. Open to comparing notes?", "first", NOW);
const dup = m.findDmDuplicate(dupStore, "I liked your concrete onboarding teardown and have a useful retention example for the same audience. Would you be open to comparing notes?");
ok(dup?.handle === "a" && dup.similarity >= 0.7, "near-duplicate outreach is detected across peers");

let paced = m.freshDmStore("owner");
for (const [i, h] of ["a", "b"].entries()) {
  paced = m.addDmCandidate(paced, "owner", { handle: h, source: "relationship", reasons: [{ id: `r${i}`, label: "measured exact connection context", source: "measured", capturedAt: NOW }] }, NOW + i).store;
  paced = m.markDmSent(paced, h, `A sufficiently specific first message to ${h} with a real shared detail and no template language.`, "first", NOW + i * 1_000);
}
ok(m.dmPacingStatus(paced, NOW + 2_000).level === "pause", "two first DMs in an hour trigger the conservative product pause");
ok(!m.canMarkDmSend(paced, "first", NOW + 2_000).ok && m.canMarkDmSend(paced, "reply", NOW + 2_000).ok, "first-touch hourly pause does not suppress truthful conversation replies");

const other = m.addDmCandidate(m.freshDmStore("owner"), "owner", { handle: "lee", source: "target" }, NOW + 100).store;
const merged = m.mergeDmStores(s, other, "owner", NOW + 10 * DAY);
ok(merged.candidates.some((x) => x.handle === "sam") && merged.candidates.some((x) => x.handle === "lee"), "cross-tab merge unions distinct candidates");
const staleSam = m.updateDmCandidate(m.freshDmStore("owner"), "sam", { stage: "closed" }, NOW - DAY);
ok(m.mergeDmStores(merged, staleSam, "owner", NOW + 10 * DAY).candidates.find((x) => x.handle === "sam").stage === "active", "stale tab cannot replace a newer conversation");

const removed = m.removeDmCandidate(merged, "lee", NOW + 11 * DAY);
const mergedAfterRemove = m.mergeDmStores(merged, removed, "owner", NOW + 12 * DAY);
ok(m.sortDmCandidates(mergedAfterRemove, NOW + 12 * DAY).every((x) => x.handle !== "lee"), "remove tombstone survives a stale-tab merge");
const revived = m.addDmCandidate(mergedAfterRemove, "owner", { handle: "lee", source: "manual" }, NOW + 13 * DAY);
ok(revived.candidate && !revived.candidate.removedAt, "explicitly adding a removed person reopens the local record");
ok(m.sortDmCandidates(m.mergeDmStores(removed, revived.store, "owner", NOW + 14 * DAY), NOW + 14 * DAY).some((x) => x.handle === "lee"), "explicit revive survives merging with an older removal tombstone");

let privacy = m.addDmCandidate(m.freshDmStore("owner"), "owner", { handle: "private", source: "manual", goal: "A private note that should be deleted", context: [{ id: "secret", kind: "note", source: "user", text: "private context", capturedAt: NOW }] }, NOW).store;
const stalePrivacy = privacy;
privacy = m.removeDmContext(privacy, "private", "secret", NOW + 1);
const privacyMerged = m.mergeDmStores(stalePrivacy, privacy, "owner", NOW + 2);
ok(privacyMerged.candidates[0].context.find((x) => x.id === "secret")?.removedAt && !privacyMerged.candidates[0].context.find((x) => x.id === "secret")?.text, "context deletion tombstone survives a stale-tab merge without retaining text");
privacy = m.removeDmCandidate(privacyMerged, "private", NOW + 3);
ok(!privacy.candidates[0].goal && !privacy.candidates[0].draft && privacy.candidates[0].context.length === 0 && privacy.candidates[0].touches.length === 0, "removing a candidate erases its private payload and keeps only a suppression tombstone");

const ranked = m.rankDmSuggestions([
  { handle: "warm", source: "relationship", exactExchanges: 3, activeWeeks: 2, lastAt: NOW - DAY },
  { handle: "big", source: "target", followers: 1_000_000 },
], new Set(), NOW);
ok(ranked[0].handle === "warm" && ranked[0].warm, "exact repeated relationship evidence outranks raw follower count");
ok(ranked.find((x) => x.handle === "big").reason.includes("research"), "cold target is labeled research, not warm intent");
ok(m.inferDmIntent({ handle: "news", source: "target", bio: "newsletter and podcast sponsorships" }) === "connect", "public profile terms never auto-assign commercial intent");

console.log(fail === 0 ? `\n✓ dm workspace: ${pass} assertions passed` : `\n✗ dm workspace: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
