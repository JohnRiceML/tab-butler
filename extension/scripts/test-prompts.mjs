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
// second-pass prompts (measured: swap-fails 60%→40%, antiGeneric +0.67)
ok(/SWAP TEST/.test(m.POST_IDEAS_JUDGE_SYSTEM) && /swapTestFails/.test(m.POST_IDEAS_JUDGE_SYSTEM), "post-ideas JUDGE flags swap-test failures (the second-pass gate)");
ok(/only THIS user could write/.test(m.POST_IDEAS_REGEN_SYSTEM) && /DIFFERENT point than the sources/.test(m.POST_IDEAS_REGEN_SYSTEM), "post-ideas REGEN rewrites flagged ideas into user-specific posts");

// ---- X_DRAFT_SYSTEM: reply-draft invariants ----
const D = m.X_DRAFT_SYSTEM;
ok(/em dash or en dash/.test(D), "reply draft keeps the no-dash rule");
ok(/generic praise/.test(D), "reply draft keeps the no-empty-praise rule");
ok(/deboosts aggressive replies/.test(D), "reply draft keeps the civility / anti-aggression tone rule");
ok(/PROFILE CLICK/.test(D), "reply draft encodes the profile-click lever (the funnel step that makes follows)");
ok(/emphasis quotes/.test(D), "reply draft bans emphasis quote-wrapping (the value paragraph's 'engage the specific claim' push was REVERTED — measured −0.2 voiceMatch for no grade/value gain, drafter was already at ceiling)");

// ---- POST_IDEA_REWRITE_SYSTEM: mirrors the tone gate so a rewrite can't undo it ----
ok(/constructive/i.test(m.POST_IDEA_REWRITE_SYSTEM) && /(dunk|sneer)/i.test(m.POST_IDEA_REWRITE_SYSTEM), "rewrite prompt mirrors the constructive-tone rule");

// ---- reply angles still wired (the draft-panel steer chips) ----
ok(Array.isArray(m.REPLY_ANGLES) && m.REPLY_ANGLES.length > 0 && m.REPLY_ANGLES.every((a) => a.id && a.directive), "REPLY_ANGLES are present and well-formed");

console.log(fail === 0 ? `\n✓ prompts: ${pass} assertions passed` : `\n✗ prompts: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
