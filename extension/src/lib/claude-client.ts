import { CONFIG, isLocalhost } from "./config";
import { idleMinutes } from "./heuristics";
import { ADVISE_SYSTEM, CLASSIFY_SYSTEM, POST_IDEA_REWRITE_SYSTEM, POST_IDEAS_SYSTEM, POST_IDEAS_JUDGE_SYSTEM, POST_IDEAS_REGEN_SYSTEM, RECALL_SYSTEM, REPLY_ANGLES, X_DRAFT_SYSTEM, X_SCORE_SYSTEM } from "./prompts";
import { cleanDraft } from "./text-clean";
import type { AdviceResult, ClassifyResult, TabInput } from "./types";

/**
 * Smart features run one of two ways, gated on the `smartEnabled` opt-in:
 *  - BYO-key: the user's Anthropic key is in storage → call the API directly
 *    (no server to run). This is the default, simplest path.
 *  - Proxy: no key set → fall back to the managed-tier proxy.
 * Either way we only ever send id/title/url/idle — never page content.
 */

export async function isSmartEnabled(): Promise<boolean> {
  return Boolean((await chrome.storage.local.get(CONFIG.SMART_ENABLED_KEY))[CONFIG.SMART_ENABLED_KEY]);
}

export async function getKey(): Promise<string | null> {
  return ((await chrome.storage.local.get(CONFIG.ANTHROPIC_KEY_KEY))[CONFIG.ANTHROPIC_KEY_KEY] as string) || null;
}

async function authHeader(): Promise<Record<string, string>> {
  // TODO(prod): real auth token for the managed tier.
  return { Authorization: "Bearer dev-placeholder-token" };
}

function toTabInput(t: chrome.tabs.Tab, now: number): TabInput | null {
  if (t.id == null || !t.url) return null;
  return { id: t.id, title: t.title ?? "", url: t.url, lastAccessedMinutes: idleMinutes(t, now) };
}

export function tabsToInputs(tabs: chrome.tabs.Tab[]): TabInput[] {
  const now = Date.now();
  return tabs.map((t) => toTabInput(t, now)).filter((x): x is TabInput => x !== null);
}

function tabsToText(tabs: TabInput[]): string {
  return tabs.map((t) => `#${t.id} | idle ${t.lastAccessedMinutes ?? "?"}m | ${t.title} | ${t.url}`).join("\n");
}

/** Direct Anthropic call (BYO-key). Returns parsed JSON, or throws. */
async function rawCall(key: string, model: string, system: string, userContent: string, maxTokens: number, temperature?: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }], ...(temperature != null ? { temperature } : {}) }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  return ((data.content || []) as { type: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** For structured (JSON) responses — scoring, grouping, recall, advice. */
async function callDirect<T>(key: string, model: string, system: string, userContent: string, maxTokens = 4096, temperature?: number): Promise<T> {
  const text = await rawCall(key, model, system, userContent, maxTokens, temperature);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("bad-output");
  const slice = text.slice(start, end + 1);
  try { return JSON.parse(slice) as T; } catch { /* salvage below */ }
  try { return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")) as T; } catch { /* trailing-comma repair failed */ }
  // Last resort: pull the individual idea objects so one bad char doesn't torch the batch.
  const objs = [...slice.matchAll(/\{[^{}]*"text"[\s\S]*?\}/g)]
    .map((mm) => { try { return JSON.parse(mm[0]); } catch { return null; } })
    .filter(Boolean);
  if (objs.length) return { ideas: objs } as unknown as T;
  throw new Error("bad-output");
}

export async function classify(tabs: chrome.tabs.Tab[]): Promise<ClassifyResult> {
  const inputs = tabsToInputs(tabs);
  const key = await getKey();
  if (key) {
    return callDirect<ClassifyResult>(key, "claude-haiku-4-5", CLASSIFY_SYSTEM, `Organize these ${inputs.length} tabs:\n\n${tabsToText(inputs)}`);
  }
  const res = await fetch(`${CONFIG.PROXY_BASE_URL}/api/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tabs: inputs }),
  });
  if (!res.ok) throw new Error(`classify: proxy ${res.status}`);
  return (await res.json()) as ClassifyResult;
}

export async function advise(tabs: chrome.tabs.Tab[]): Promise<AdviceResult> {
  const now = Date.now();
  const inputs = tabsToInputs(tabs);
  const key = await getKey();
  if (key) {
    return callDirect<AdviceResult>(key, "claude-haiku-4-5", ADVISE_SYSTEM, `Tabs:\n${tabsToText(inputs)}`);
  }
  const localhost = tabs
    .filter((t) => t.url && isLocalhost(t.url))
    .map((t) => {
      let port = 0;
      try { port = Number(new URL(t.url!).port) || 0; } catch { /* ignore */ }
      return { port, title: t.title, idleMinutes: idleMinutes(t, now) };
    });
  const res = await fetch(`${CONFIG.PROXY_BASE_URL}/api/advise`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ tabs: inputs, localhost }),
  });
  if (!res.ok) throw new Error(`advise: proxy ${res.status}`);
  return (await res.json()) as AdviceResult;
}

/* ---------- semantic recall (BYO-key) ---------- */

export interface Candidate { title: string; url: string; source: string; }
export interface RankedResult extends Candidate { why: string; }

/** Claude-ranked search over a candidate set (open tabs + archive + history). */
export async function recall(query: string, candidates: Candidate[]): Promise<RankedResult[]> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const numbered = candidates.map((c, i) => `${i}. ${c.title} | ${c.url}`).join("\n");
  const raw = await callDirect<{ results: { i: number; why: string }[] }>(
    key,
    "claude-haiku-4-5",
    RECALL_SYSTEM,
    `Query: ${query}\n\nPages:\n${numbered}`,
  );
  return (raw.results || [])
    .map((r) => (candidates[r.i] ? { ...candidates[r.i], why: r.why } : null))
    .filter((x): x is RankedResult => x !== null);
}

/* ---------- X reply copilot (BYO-key) ---------- */

export interface XPost { i: number; author: string; text: string; meta?: string; }
export interface XScore { i: number; score: number; reason: string; category?: string; products?: string[]; }

/** Score posts for reply-worthiness given the user's niche. Cheap (Haiku).
 *  When products are supplied, the scorer also tags each PROMOTE post with the
 *  best-fit product index. */
export async function scorePosts(posts: XPost[], niche: string, products: { name: string; blurb?: string }[] = []): Promise<XScore[]> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const list = posts.map((p) => `${p.i}. @${p.author}${p.meta ? ` [${p.meta}]` : ""}: ${p.text}`).join("\n");
  const prods = products.length
    ? `\n\nThe user's products (for a post you categorize "promote", set "products" to the 0-based indices of the product(s) that genuinely fit, most relevant first, up to 2; omit if none clearly fits):\n${products.map((p, i) => `${i}. ${p.name}${p.blurb ? ` — ${p.blurb}` : ""}`).join("\n")}`
    : "";
  const raw = await callDirect<{ scores: { i: number; score: number; reason: string; category?: string; products?: number[] }[] }>(
    key,
    "claude-haiku-4-5",
    X_SCORE_SYSTEM,
    `User niche / what's worth replying to:\n${niche || "(not set — only flag posts clearly answerable with specific expertise; be extra strict)"}\n\nPosts:\n${list}${prods}`,
    1024,
  );
  // Resolve product indices to NAMES here (against the list we sent), so the
  // content script maps by identity — robust to the user reordering/editing
  // products between scoring and rendering.
  return (raw.scores || []).map((s) => ({
    i: s.i, score: s.score, reason: s.reason, category: s.category,
    products: Array.isArray(s.products)
      ? s.products.map((idx) => products[idx]?.name).filter((n): n is string => !!n).slice(0, 2)
      : undefined,
  }));
}


/** Draft a reply in the user's voice. Quality matters → Sonnet. An optional
 *  `angle` (REPLY_ANGLES id) steers the strategy without overriding the voice. */
export async function draftReply(post: { author: string; text: string; context?: string }, voice: string, angle?: string, product?: string, steer?: string, extra?: string): Promise<string> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const ctx = post.context ? `\n\nParent/quoted post (for context):\n${post.context}` : "";
  const prod = product?.trim() ? `\n\nThe user's own product/work (mention ONLY if this post invites it or it genuinely adds value):\n${product.trim()}` : "";
  const def = angle ? REPLY_ANGLES.find((a) => a.id === angle) : undefined;
  const angleLine = def ? `\n\n${def.directive}` : "";
  // Free-text steer the user typed on the draft panel — honored strongly, but it never
  // overrides the voice or the hard rules in the system prompt (no emojis/hashtags/etc.).
  const steerLine = steer?.trim() ? `\n\nThe user wants this specific steer on the reply: ${steer.trim()}\nFollow it as closely as you can while keeping their voice and all the rules above.` : "";
  // Plain text, not JSON — free-form reply prose is fragile to JSON-wrap/parse.
  const reply = await rawCall(
    key,
    "claude-sonnet-4-6",
    X_DRAFT_SYSTEM,
    `User voice:\n${voice || "(not set — write terse and specific; no marketing language, no adjectives-for-the-sake-of-it, no emojis, no hashtags)"}\n\nReply to @${post.author}'s post:\n${post.text}${ctx}${extra ?? ""}${prod}${angleLine}${steerLine}`,
    400,
  );
  return cleanDraft(reply); // dashes + quote-wrapping net (prompt says it, this guarantees it)
}

/** Per-idea quality call-out from the judge — surfaced in the UI so the user can triage (ship the
 *  strong, fix the ok/weak, skip the rest). Distinct from the virality band (which is source reach). */
export interface Grade { tier: "strong" | "ok" | "weak"; lever?: string; callout?: string; fixable?: boolean; }
export interface PostIdea { text: string; source: string; pattern: string; why: string; critique: string; hookStrength: number; grade?: Grade; }
export interface OwnPostLite { text: string; likes?: number; reposts?: number; }

/** Turn over-performing posts in the user's niche into ORIGINAL post ideas in
 *  their voice. Remixes the winning PATTERNS, never the content. Quality → Sonnet.
 *  The model scores ONLY hookStrength (0-3); the honest virality band is computed in the
 *  content script from hookStrength + the real measured rank of the source it remixed. */
export async function generatePostIdeas(posts: { author: string; text: string; likes?: number; reposts?: number; followers?: number; shape?: string }[], voice: string, niche: string, ownPosts: OwnPostLite[] = [], followers?: number, shapeLine?: string): Promise<PostIdea[]> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const list = posts.map((p, i) => {
    const eng = (p.likes ?? 0) + (p.reposts ?? 0);
    const ctx = p.followers ? `${eng} eng on ~${p.followers} followers` : `${eng} eng`;
    return `${i + 1}. @${p.author} [${ctx}${p.shape ? ` \u00b7 ${p.shape}` : ""}]: ${p.text.replace(/\s+/g, " ").slice(0, 280)}`;
  }).join("\n");
  // The user's own recent posts: primary voice/structure anchor + de-dupe guard. Top engagers
  // first + flagged "(this landed for you)" so "EXTEND your themes" operates on winners.
  const sortedOwn = [...ownPosts].sort((a, b) => ((b.likes ?? 0) + (b.reposts ?? 0)) - ((a.likes ?? 0) + (a.reposts ?? 0)));
  const ownBlock = sortedOwn.length
    ? `\n\nThe user's OWN recent posts (your PRIMARY voice + structure anchor; do NOT duplicate these topics, angles, takes, or examples — extend their themes from a new angle):\n${sortedOwn.slice(0, 15).map((p, i) => `${i + 1}. ${i < 3 ? "(this landed for you) " : ""}${p.text.replace(/\s+/g, " ").slice(0, 280)}`).join("\n")}`
    : "\n\n(The user's own posts were not available — the VOICE blurb is from REPLIES, so lean on it for tone only. COLD-START RULE: with no real person visible, contrarian / myth-bust / say-the-quiet-part shapes read as an LLM's idea of spicy — prefer plain, concrete, understated observations and questions; earn edge only from specifics you can actually ground.)";
  const fol = followers ? `\n\nUser approximate followers: ~${followers} (aim the post at this reach tier).` : "";
  const shp = shapeLine?.trim() ? `\n\nMEASURED shape signal for this user (X-reported, settled posts only): ${shapeLine.trim()} When two seeds are equally strong, prefer that shape for 1-2 of the 5 — never force it onto a weak seed.` : "";
  const userMsg = `User niche / what they post about:\n${niche || "(not set)"}\n\nUser voice (from their REPLIES — tone + word choice only, NOT post structure):\n${voice || "(not set — write terse and specific; no marketing language, no emojis, no hashtags)"}${ownBlock}${fol}${shp}\n\nOver-performing posts from others in the space (remix the PATTERNS, never copy the content):\n${list}`;
  const raw = await callDirect<{ ideas: { text: string; source?: string; pattern: string; why: string; critique?: string; hookStrength?: number }[] }>(
    key,
    "claude-sonnet-4-6",
    POST_IDEAS_SYSTEM,
    userMsg,
    2200,
    // temperature deliberately UNSET: a measured A/B (2026-07) showed 0.7 scored WORSE across the
    // board on the live judge (more conservative = more generic) — the default sampling wins.
  );
  const ideas = (raw.ideas || [])
    .slice(0, 6)
    .map((d) => ({ text: cleanDraft(d.text || ""), source: (d.source || "").replace(/^@/, "").trim(), pattern: (d.pattern || "").trim(), why: (d.why || "").trim(), critique: (d.critique || "").trim(), hookStrength: Math.max(0, Math.min(3, Math.round(Number(d.hookStrength) || 0))) }))
    .filter((d) => d.text);
  // SECOND PASS (measured 2026-07: swap-fails 60%→40%, antiGeneric +0.67): a cheap Haiku judge flags
  // the ideas that fail the swap test, then Sonnet regenerates ONLY those into user-specific posts.
  return refinePostIdeas(key, ideas, userMsg);
}

/** The reject-and-regenerate second pass. Judge (Haiku) flags swap-test failures → regen (Sonnet)
 *  rewrites just those. Best-effort: any error returns the pass-1 ideas, so it never breaks a
 *  generation. A regenerated idea is an original on a new point, so its source attribution is
 *  dropped (honest — it bands as an own-theme idea, no false proof post). */
async function refinePostIdeas(key: string, ideas: PostIdea[], userMsg: string): Promise<PostIdea[]> {
  if (ideas.length < 2) return ideas;
  const gradeBatch = async (batch: PostIdea[], indexNote = ""): Promise<Grade[]> => {
    const msg = `${userMsg}\n\nGrade these ${batch.length} generated ideas${indexNote}, in order:\n${batch.map((d, i) => `${i + 1}. ${d.text}`).join("\n\n")}`;
    const v = await callDirect<{ grades?: Grade[] }>(key, "claude-haiku-4-5", POST_IDEAS_JUDGE_SYSTEM, msg, 700);
    return (v.grades || []).map((g) => ({ tier: g?.tier === "strong" || g?.tier === "weak" ? g.tier : "ok", lever: (g?.lever || "").trim() || undefined, callout: (g?.callout || "").trim() || undefined, fixable: g?.fixable !== false }));
  };
  try {
    const out = ideas.slice();
    const grades = await gradeBatch(out);
    out.forEach((d, i) => { if (grades[i]) d.grade = grades[i]; }); // attach the call-out to every idea
    // Auto-fix the WEAK ones (the second pass): regenerate, then RE-GRADE just those so their shown
    // call-out matches the new text (never a stale grade). source dropped — a regen is an original.
    const fails = out.map((d, i) => (d.grade?.tier === "weak" ? i : -1)).filter((i) => i >= 0);
    if (fails.length) {
      const flagged = fails.map((i) => out[i].text);
      const regenMsg = `${userMsg}\n\nThe drafts that failed the swap test (rewrite each into something only this user could post, in order):\n${flagged.map((t, k) => `${k + 1}. ${t}`).join("\n\n")}`;
      const re = await callDirect<{ ideas?: { text?: string; why?: string; pattern?: string }[] }>(key, "claude-sonnet-4-6", POST_IDEAS_REGEN_SYSTEM, regenMsg, 1600);
      const regenerated: { idx: number; idea: PostIdea }[] = [];
      fails.forEach((idx, k) => {
        const r = (re.ideas || [])[k];
        const txt = cleanDraft(r?.text || "");
        if (!txt) return;
        out[idx] = { ...out[idx], text: txt, source: "", why: (r?.why || "").trim() || "Rewritten to be specific to your own work, not a niche template.", pattern: (r?.pattern || "").trim(), grade: undefined };
        regenerated.push({ idx, idea: out[idx] });
      });
      if (regenerated.length) {
        try {
          const fresh = await gradeBatch(regenerated.map((r) => r.idea), " (each rewritten to be more specific)");
          regenerated.forEach((r, k) => { out[r.idx].grade = fresh[k] || { tier: "ok" }; });
        } catch { /* re-grade is best-effort — a regenerated idea just shows no badge */ }
      }
    }
    return out;
  } catch { return ideas; }
}

/** Rewrite one post idea per a steer, keeping the same topic + the user's voice. Sonnet, cheap. */
export async function generatePostIdeaRewrite(text: string, steer: string, voice: string, source?: string, pattern?: string): Promise<string> {
  const key = await getKey();
  if (!key) throw new Error("no-key");
  const src = source?.trim() ? `\n\nThe source post whose pattern it borrows (for grounding, do NOT copy it):\n${source.trim().slice(0, 280)}` : "";
  const pat = pattern?.trim() ? `\n\nPattern it uses: ${pattern.trim()}` : "";
  const out = await rawCall(
    key,
    "claude-sonnet-4-6",
    POST_IDEA_REWRITE_SYSTEM,
    `User voice:\n${voice || "(not set — terse and specific; no marketing language, no emojis, no hashtags)"}\n\nCurrent draft:\n${text}\n\nSteer (how to change it): ${steer}${pat}${src}`,
    400,
  );
  return cleanDraft(out); // dashes + quote-wrapping net
}
