/**
 * Static prompt-invariant guard (Layer A) for the load-bearing rules in prompts.ts — the honesty,
 * anti-AI-tell, source-attribution, and X-ranker levers the post-ideas + reply-draft prompts encode.
 * The real generation QUALITY is judged by the opt-in Layer B (eval-post-ideas-live.mjs); this $0
 * check just makes sure a silent prompt edit can't DELETE an invariant and still ship green.
 * esbuild → data-URL import (prompts.ts is import-free). Run: node scripts/test-prompts.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/lib/prompts.ts"), "utf8");
const js = esbuild.transformSync(src, { loader: "ts", format: "esm" }).code;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error("  FAIL:", l); } };

// ---- POST_IDEAS_SYSTEM: honesty + quality invariants (deletions here silently degrade output) ----
const P = m.POST_IDEAS_SYSTEM;
ok(/NO DASHES/.test(P), "post-ideas keeps the NO DASHES rule");
ok(/handle EXACTLY as written/.test(P), "post-ideas keeps the exact-handle source-attribution rule (load-bearing for honest banding)");
ok(/judge ONLY line 1/.test(P), "post-ideas keeps 'hookStrength judges ONLY line 1'");
ok(/PROVEN ANGLE/.test(P), "post-ideas keeps the PROVEN ANGLE (own-winners) steer");
ok(/insider specificity/.test(P) && /ANY EXPERTISE NICHE/.test(P), "post-ideas playbook is vertical-agnostic (insider specificity for any niche, not builder-only)");
ok(/throttle/i.test(P) && /dunk/i.test(P), "post-ideas encodes the 2026 ranker tone gate (constructive amplified, combative throttled)");
ok(/FINAL SWEEP/.test(P), "post-ideas keeps the final anti-slop sweep (eval-measured: banned constructions were slipping through without it)");
ok(/BANGER SCREEN/.test(P) && /slop/i.test(P), "post-ideas keeps the banger-screen self-check anchored to X's real slop/quality gate (grounded in banger_initial_screen.py)");
ok(/ECHOES A SOURCE/.test(P), "post-ideas keeps the source-echo kill (eval-measured: 4/5 ideas were recognizable source remixes)");
ok(/BLUNTNESS RULE/.test(P), "post-ideas keeps the bluntness voice rule (eval-measured: drafts over-polished vs terse users)");
ok(/KILL IF MOLD/.test(P) && /negation-reframe/.test(P), "post-ideas keeps the mold-ban (audit-measured: the 'X isn't Y it's Z' reframe drove ~7/20 slop)");
ok(/KILL IF IT LIFTS THE BEST LINE/.test(P), "post-ideas keeps the best-line anti-lift (audit: the 2 most quotable posts were source costume-lifts)");
ok(/NO QUOTE-WRAPPING/.test(P), "post-ideas bans emphasis quote-wrapping");
ok(/SEMANTIC DISCOVERY/.test(P) && /never make the ranker guess/.test(P), "post-ideas encodes the 2026 semantic-discovery rule (name the subject in the audience's real words so the interest-embedding ranker can place it; no keyword-stuffing)");
ok(/not-interested/.test(P) && /net-negative/.test(P), "post-ideas tone gate accounts for predicted negative signals (not-interested/mute/block/report subtract; strong in-niche opinion GOOD, out-of-niche ragebait net-negative)");
ok(/send this to/.test(P), "post-ideas banger screen aims each post at a send/share/profile-click (the highest-value reaction beats a drive-by like)");
// second-pass prompts (measured: swap-fails 60%→40%, antiGeneric +0.67)
ok(/SWAP TEST/.test(m.POST_IDEAS_JUDGE_SYSTEM) && /"grades"/.test(m.POST_IDEAS_JUDGE_SYSTEM) && /tier/.test(m.POST_IDEAS_JUDGE_SYSTEM) && /callout/.test(m.POST_IDEAS_JUDGE_SYSTEM), "post-ideas JUDGE returns a per-idea grade (tier + call-out) — drives the second pass AND the UI call-out");
ok(/only THIS user could write/.test(m.POST_IDEAS_REGEN_SYSTEM) && /DIFFERENT point than the sources/.test(m.POST_IDEAS_REGEN_SYSTEM), "post-ideas REGEN rewrites flagged ideas into user-specific posts");

// ---- X_DRAFT_SYSTEM: reply-draft invariants ----
const D = m.X_DRAFT_SYSTEM;
ok(/em dash or en dash/.test(D), "reply draft keeps the no-dash rule");
ok(/generic praise/.test(D), "reply draft keeps the no-empty-praise rule");
ok(/deboosts aggressive replies/.test(D), "reply draft keeps the civility / anti-aggression tone rule");
ok(/PROFILE CLICK/.test(D), "reply draft encodes the profile-click lever (the funnel step that makes follows)");
ok(/conversation ranker/.test(D), "reply draft names the specific claim it engages so the 2026 conversation-ranker can place it (kept to one sentence — drafter is at measured ceiling, and this is scoped to semantic placement, NOT the reverted value-paragraph push)");
ok(/emphasis quotes/.test(D), "reply draft bans emphasis quote-wrapping (the value paragraph's 'engage the specific claim' push was REVERTED — measured −0.2 voiceMatch for no grade/value gain, drafter was already at ceiling)");

// ---- X_SCORE_SYSTEM: observed relationship context ----
const XS = m.X_SCORE_SYSTEM;
ok(/DIRECT COMMENT ON THE USER'S OWN POST/.test(XS) && /warm inbound conversation/.test(XS), "reply scorer treats comments on the user's post as first-class warm inbound context");
ok(/obvious spam, abuse, generic link drops, or bot bait/.test(XS), "warm inbound scoring still rejects abusive and automated comments");

// ---- DM_DRAFT_SYSTEM: consent, specificity, and manual-send boundaries ----
const DM = m.DM_DRAFT_SYSTEM;
ok(/ONE thoughtful X Direct Message/.test(DM) && /send manually/.test(DM), "DM prompt stays one-message and manual-send only");
ok(/Never invent familiarity/.test(DM) && /recipient intent/.test(DM), "DM prompt cannot manufacture relationship or buying intent");
ok(/One clear ask maximum/.test(DM) && /easy to decline/.test(DM), "DM prompt keeps a single low-pressure ask");
ok(/one unanswered follow-up maximum/i.test(DM) && /add new value/i.test(DM), "DM prompt keeps the one-follow-up, new-value rule");
ok(/Never propose a link swap/.test(DM) && /Never invent budget/.test(DM), "DM commercial angles preserve backlink and sponsor honesty guards");

// ---- POST_IDEA_REWRITE_SYSTEM: mirrors the tone gate so a rewrite can't undo it ----
ok(/constructive/i.test(m.POST_IDEA_REWRITE_SYSTEM) && /(dunk|sneer)/i.test(m.POST_IDEA_REWRITE_SYSTEM), "rewrite prompt mirrors the constructive-tone rule");

// ---- shared ban set: regen + rewrite must inherit the FULL generation ban set (else a steer-
// rewrite / regen silently reintroduces molds/dashes/AI-tells that generation forbade) ----
ok(/No em\/en dash/.test(m.SHARED_POST_BANS) && /negation-reframe/.test(m.SHARED_POST_BANS) && /emphasis quotes/.test(m.SHARED_POST_BANS), "SHARED_POST_BANS carries the dash + negation-reframe + quote-wrap bans");
ok(m.POST_IDEAS_REGEN_SYSTEM.includes(m.SHARED_POST_BANS), "regen prompt inherits the shared ban set");
ok(m.POST_IDEA_REWRITE_SYSTEM.includes(m.SHARED_POST_BANS), "rewrite prompt inherits the shared ban set (was strictly weaker before)");
ok(/ADDITIVE .it's not just X, it's Y. is a different construction and is banned outright/.test(P), "post-ideas resolves the two-negation-template contradiction (substitution allowed ≤1, additive banned 0)");

// ---- reply angles still wired (the draft-panel steer chips) ----
ok(Array.isArray(m.REPLY_ANGLES) && m.REPLY_ANGLES.length > 0 && m.REPLY_ANGLES.every((a) => a.id && a.directive), "REPLY_ANGLES are present and well-formed");

console.log(fail === 0 ? `\n✓ prompts: ${pass} assertions passed` : `\n✗ prompts: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
