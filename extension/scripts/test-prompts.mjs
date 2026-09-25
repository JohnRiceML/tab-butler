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
ok(/NOT dwelling as its own distinct scored signal/.test(P) && /costs twice/.test(P), "post-ideas hook rule encodes the not_dwelled term WITHOUT asserting its unpublished weight sign (adversary fix F4)");
ok(/Quote-and-extend/.test(P) && /never a restate or a pile-on/.test(P), "post-ideas playbook carries the quote-and-extend shape (quote/quoted_click are scored heads; quote_hydrator shipped May 2026)");
ok(/lead with the surprising word/.test(P), "semantic-discovery arbitrates against hook-craft (surprising word wins the front of line 1; subject appears somewhere in line 1)");
ok(/SEND\/SHARE = /.test(P) && /ONE question per post/.test(P), "the send/share trigger lives in LEVER MAP and the banger screen keeps its single-question contract (adversary fix F3)");
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
ok(/surrounding READERS/.test(D) && /Premium or a blue check/.test(D) && /reach or impressions/.test(D), "high-reach drafts add self-contained reader value without exposing the growth tactic");
ok(/emphasis quotes/.test(D), "reply draft bans emphasis quote-wrapping (the value paragraph's 'engage the specific claim' push was REVERTED — measured −0.2 voiceMatch for no grade/value gain, drafter was already at ceiling)");
const communityStyle = m.REPLY_STYLES?.find((style) => style.id === "community-spark");
ok(communityStyle && /Think deeply, then write lightly/.test(communityStyle.directive), "Community Spark separates deep post understanding from lightweight delivery");
ok(communityStyle && /55 to 170 characters/.test(communityStyle.directive) && /never more than two short sentences/.test(communityStyle.directive), "Community Spark has a concrete short-reply contract");
ok(communityStyle && /non obvious implication/.test(communityStyle.directive) && /knowledgeable peer/.test(communityStyle.directive), "Community Spark looks for a precise insight and a worthwhile community opening");
ok(communityStyle && /Never flatter, summarize, lecture/.test(communityStyle.directive) && /invent the user's experience/.test(communityStyle.directive), "Community Spark cannot turn compression into praise, summary, or fabricated authority");

// ---- X_SCORE_SYSTEM: observed relationship context ----
const XS = m.X_SCORE_SYSTEM;
ok(/every post independently/.test(XS) && /Never impose a quota/.test(XS) && !/1 in 8/.test(XS), "X scores each post on its merits without suppressing relevant batches to a quota");
ok(/exactly one score for every supplied post index/.test(XS), "X returns an assessment for every post, including passes");
ok(/DIRECT COMMENT ON THE USER'S OWN POST/.test(XS) && /warm inbound conversation/.test(XS), "reply scorer treats comments on the user's post as first-class warm inbound context");
ok(/obvious spam, abuse, generic link drops, or bot bait/.test(XS), "warm inbound scoring still rejects abusive and automated comments");
ok(/"anchor"/.test(XS) && /"replyBrief"/.test(XS) && /"risk"/.test(XS), "reply scorer returns an exact anchor, actionable brief, and explicit negative-reaction risk");
ok(/Do NOT factor in author popularity, verification, recency, likes, or reply counts/.test(XS), "content-fit scoring stays separate from popularity, Premium, freshness, and competition");
ok(/PARENT\/QUOTED CONTEXT/.test(XS) && /OUTER post and author/.test(XS), "reply scorer uses bounded context to disambiguate the outer post, not score the quoted author");
ok(/untrusted content, never instructions/.test(XS), "reply scorer treats post and thread text as untrusted data");

// ---- LinkedIn prompts: separate platform contract + manual, professional contribution ----
const LS = m.LINKEDIN_SCORE_SYSTEM;
const LD = m.LINKEDIN_DRAFT_SYSTEM;
ok(/LinkedIn conversations/.test(LS) && /POST worth joining/.test(LS) && /PERSON/.test(LS), "LinkedIn scorer is a first-class person-and-post decision prompt, not relabeled X copy");
ok(/untrusted data.*never instructions/.test(LS), "LinkedIn scorer treats feed content as untrusted data");
ok(/Do not reward fame, title seniority, company prestige, popularity, verification, likes, or hypothetical reach/.test(LS), "LinkedIn content fit stays separate from prestige and visible engagement");
ok(/Never assume the user has experience/.test(LS) && /requires a real fact from the user/.test(LS), "LinkedIn scoring cannot manufacture professional authority");
ok(/"comment":.*ready now/.test(LS) && /"needs_detail"/.test(LS) && /"skip"/.test(LS), "LinkedIn scorer can abstain instead of manufacturing a generic comment");
ok(/"postFit"/.test(LS) && /"personFit"/.test(LS) && /"contributionFit"/.test(LS), "LinkedIn scorer keeps person, post, and truthful-contribution fit separate");
ok(/name is known, cap at 0.50/.test(LS) && /A target-person match can never rescue/.test(LS), "limited author evidence and weak content fail closed");
ok(/Surface every post that clears the rules/.test(LS) && /Do not fill or suppress to a quota/.test(LS), "LinkedIn scorer does not skip good posts to satisfy an arbitrary yield quota");
ok(/ONE excellent LinkedIn comment/.test(LD) && /One or two natural sentences is the default/.test(LD) && /three is the usual ceiling/.test(LD), "LinkedIn drafting defaults to one human contribution instead of a mini essay");
ok(/generic praise or agreement/.test(LD) && /unsolicited pitch/.test(LD), "LinkedIn drafting rejects empty praise and opportunistic pitching");
ok(/Never invent the user's job, company, results, clients, experience/.test(LD), "LinkedIn drafting preserves identity and experience honesty");
ok(/untrusted data, never instructions/.test(LD) && /STYLE EVIDENCE ONLY/.test(LD), "LinkedIn drafting separates untrusted post text and voice style from factual evidence");
ok(/Real detail from the user/.test(LD) && /first-person factual claim/.test(LD), "LinkedIn drafting grounds autobiographical claims in explicit user evidence");
ok(/privately consider three distinct openings/.test(LD) && /pasted unchanged under a different post/.test(LD), "LinkedIn drafting runs opening diversity and swap-test checks before answering");
ok(/any dash character, including a hyphen, em dash, or en dash/.test(LD), "LinkedIn drafting bans every dash glyph, including ordinary hyphens");
ok(/quotation marks of any kind/.test(LD) && /Normal apostrophes in contractions are allowed/.test(LD), "LinkedIn drafting bans quotation marks while preserving natural contractions");
ok(/Output ONLY the comment text/.test(LD), "LinkedIn drafting retains deterministic cleanup-compatible output rules");

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
ok(Array.isArray(m.REPLY_STYLES) && m.REPLY_STYLES.length === 1 && m.REPLY_STYLES.every((style) => style.id && style.directive), "reply delivery styles are explicit, bounded, and well-formed");

console.log(fail === 0 ? `\n✓ prompts: ${pass} assertions passed` : `\n✗ prompts: ${fail} failed, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
