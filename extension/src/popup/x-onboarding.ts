import { CONFIG } from "../lib/config";
import {
  isXOnboardingConfigured, onboardingProgress, onboardingStage, transitionXOnboarding,
  type OnboardingStore, type XOnboardingInput,
} from "../lib/x-onboarding";
export { shouldShowXOnboarding } from "../lib/x-onboarding";

const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const has = (store: OnboardingStore, key: string): boolean => typeof store[key] === "string" && Boolean((store[key] as string).trim());

/** Render only saved status, never saved key values. Unsaved fields stay in the DOM on validation errors. */
export function renderXOnboarding(store: OnboardingStore): string {
  const stage = onboardingStage(store);
  const progress = onboardingProgress(store);
  const jev = progress?.provider === "jev";
  const alreadyActive = isXOnboardingConfigured(store) && store[CONFIG.X_COPILOT_KEY] !== false && store[CONFIG.X_PAUSED_KEY] !== true;
  const step = ["welcome", "providers", "focus", "finish"].indexOf(stage);
  const steps = ["Choose", "Connect", "Focus", "First reply"];
  const titles = ["A little help finding your next conversation.", "Connect your providers.", "What do you want to talk about?", "You're one conversation away."];
  let body = "";
  if (stage === "welcome") {
    body = `<p class="onboarding-intro">Goobi finds X posts you can contribute to and helps you write a thoughtful reply. You choose what to say and post it yourself.</p>
      <div class="onboarding-expectations"><b>Bring your own API keys</b><p>Claude needs an Anthropic API key. The recommended Jev setup also needs a TypeSafe API key. These providers bill API usage separately; a ChatGPT or Claude chat subscription does not cover these calls.</p><p>Setup is local and makes no paid test calls. ${alreadyActive ? "Your current X copilot stays on until you save a new connection." : "Feed analysis starts only after you finish and enable Goobi."} You can switch it off anytime.</p></div>
      <div class="onboarding-choices">
        <button class="onboarding-choice" data-action="x-onboarding-choose-jev"><span class="onboarding-choice-title">Jev + Claude <span class="onboarding-recommended">Recommended</span></span><span>Jev finds relevant conversations. Claude drafts your replies.</span><span class="field-hint">TypeSafe key + Anthropic key</span></button>
        <button class="onboarding-choice" data-action="x-onboarding-choose-claude"><span class="onboarding-choice-title">Claude only</span><span>Claude handles both feed analysis and reply drafts.</span><span class="field-hint">One Anthropic key</span></button>
      </div>`;
  } else if (stage === "providers") {
    body = `<p class="onboarding-intro">${jev ? "Jev will analyze your feed; Claude will write drafts when you ask." : "Claude will analyze your feed and write drafts when you ask."} Keys stay in Chrome on this device.</p>
      <div class="onboarding-field"><label class="field" for="onboarding-anthropic-key">Anthropic API key <span class="field-hint">for Claude</span></label><input class="control" id="onboarding-anthropic-key" type="password" autocomplete="off" spellcheck="false" placeholder="${has(store, CONFIG.ANTHROPIC_KEY_KEY) ? "Saved — leave blank to keep it" : "Paste your Anthropic API key"}" aria-describedby="onboarding-key-help"/></div>
      ${jev ? `<div class="onboarding-field"><label class="field" for="onboarding-typesafe-key">TypeSafe API key <span class="field-hint">for Jev</span></label><input class="control" id="onboarding-typesafe-key" type="password" autocomplete="off" spellcheck="false" placeholder="${has(store, CONFIG.TYPESAFE_KEY_KEY) ? "Saved — leave blank to keep it" : "Paste your TypeSafe API key"}" aria-describedby="onboarding-key-help"/></div>` : ""}
      <p class="field-hint" id="onboarding-key-help">Create a key in <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">Claude Console</a>${jev ? ` and <a href="https://console.typesafe.ai/" target="_blank" rel="noopener noreferrer">TypeSafe Console</a>` : ""}. Saving does not test or charge them. Provider billing and access must be active when you start using Goobi.</p>
      <div class="data-disclosure"><b>X data use</b>${jev ? "With Jev enabled, public feed posts, quoted context, author details, and your saved focus go to TypeSafe as you scroll. Claude receives selected content, your saved voice, SOUL.md, and relevant context only when you request a reply draft or Ideas. If you later choose Claude analysis, public posts, author handles, focus, and saved product descriptions go to Anthropic as you scroll." : "While Goobi is on, public feed posts, author handles, saved focus, and saved product names/descriptions go to Anthropic automatically as you scroll. Reply drafts and Ideas also send selected content, voice, SOUL.md, and relevant context when you request them."} You review and post every reply yourself.
        <details class="fold onboarding-disclosure"><summary>Other tools and saved data</summary><div>DM drafts send the selected voice and conversation context to Anthropic, without SOUL.md. Optional X data features send handles and search queries to RapidAPI. Imported analytics CSVs are parsed locally and raw rows discarded; only aggregate pattern/length evidence is sent to Claude when you request Ideas or draft with Community Spark enabled (on by default, switchable in the draft panel). Activity, drafts, DM notes, goals, SOUL.md, growth history, and aggregate models stay in Chrome local storage. Goobi has no analytics or production server. Optional comment review has its own separate consent and is not enabled by this setup.</div></details>
        ${store[CONFIG.X_DATA_CONSENT_KEY] === "v1" ? `<p class="ready-check">✓ X data use already accepted</p>` : `<label class="data-consent"><input id="onboarding-x-consent" type="checkbox"/> <span>I agree to this X data use.</span></label>`}
      </div>
      ${jev ? `<div class="data-disclosure"><b>Separate Jev permission</b>TypeSafe receives visible X post text, quoted context, displayed author details, and your focus for analysis. If you separately enable LinkedIn, its visible posts and comment thesis are included too. Product descriptions, SOUL.md, personal facts, drafts, voice, and own-post history are excluded from Jev analysis. This choice applies to both platforms. Jev errors stay visible; Goobi does not silently fall back to Claude.
        ${store[CONFIG.JEV_ANALYSIS_CONSENT_KEY] === "v1" ? `<p class="ready-check">✓ Jev analysis data use already accepted</p>` : `<label class="data-consent"><input id="onboarding-jev-consent" type="checkbox"/> <span>I agree to this TypeSafe data use for Jev analysis.</span></label>`}
      </div>` : ""}
      <p class="field-hint">Saving pauses the X copilot until you finish setup. ${store[CONFIG.LI_COPILOT_KEY] === true ? "Your analysis provider choice also applies to your enabled LinkedIn copilot." : "LinkedIn and optional draft review keep their own settings."}</p>
      <button class="btn primary onboarding-next" data-action="x-onboarding-providers">Save and continue</button>`;
  } else if (stage === "focus") {
    body = `<p class="onboarding-intro">Give Goobi a few topics and the kind of people or conversations you want to join. You can change this anytime.</p>
      <div class="onboarding-field"><label class="field" for="onboarding-focus">Your focus <span class="field-hint">required</span></label><textarea class="control" id="onboarding-focus" rows="4" maxlength="2000" placeholder="I'm building a small SaaS. Find practical conversations with founders about customer interviews, onboarding, and what they've learned from shipping.">${esc(store[CONFIG.X_NICHE_KEY])}</textarea></div>
      <details class="fold"${has(store, CONFIG.X_VOICE_KEY) ? " open" : ""}><summary>Your voice <span class="field-hint">optional</span></summary><div class="onboarding-fold-body"><label class="field" for="onboarding-voice">How should your replies sound?</label><textarea class="control" id="onboarding-voice" rows="3" maxlength="6000" placeholder="Short and curious. Plain language, no hype. Ask specific questions.">${esc(store[CONFIG.X_VOICE_KEY])}</textarea><p class="field-hint">Describe your style or paste a reply you like. Leave it blank to start with Goobi's default.</p></div></details>
      <button class="btn primary onboarding-next" data-action="x-onboarding-focus">Save my focus</button>`;
  } else {
    body = `<p class="onboarding-intro">Your setup is saved. ${jev ? "Jev will find the conversations; Claude will help with the words." : "Claude will find the conversations and help with the words."}</p>
      <div class="onboarding-recap"><span class="field-hint">Your focus</span><p>${esc(store[CONFIG.X_NICHE_KEY])}</p></div>
      <ol class="onboarding-walkthrough"><li><b>Open your X feed.</b><span>Sign in if needed, then scroll to let Goobi find relevant conversations.</span></li><li><b>Choose a post and request a draft.</b><span>Open Goobi's dock, pick a suggestion, and click Draft.</span></li><li><b>Make it yours, then post.</b><span>Review the wording and facts. Copy the reply, paste it into X, and post when you're happy with it.</span></li></ol>
      <p class="field-hint">Enabling starts paid provider usage when X content is analyzed. Your first request checks provider access; setup has made no test calls.</p>
      <button class="btn primary onboarding-next" data-action="x-onboarding-finish">Enable Goobi + open X</button>`;
  }
  return `<section class="onboarding" aria-labelledby="x-onboarding-title">
    <header class="onboarding-header"><div class="row-flex gap10"><div class="sq" id="onboarding-goobi" aria-hidden="true"></div><div class="wordmark"><div class="brand">Goobi</div><div class="tagline">Your first good conversation starts here.</div></div></div><span class="pill">Step ${step + 1} of 4</span></header>
    <ol class="onboarding-progress" aria-label="Setup progress">${steps.map((label, i) => `<li${i === step ? ' aria-current="step"' : ""} class="${i < step ? "done" : ""}"><span aria-hidden="true">${i < step ? "✓" : i + 1}</span>${label}</li>`).join("")}</ol>
    <div class="setup onboarding-panel"><h1 id="x-onboarding-title" tabindex="-1">${titles[step]}</h1>${body}<p id="x-onboarding-error" class="onboarding-error" role="alert" aria-live="assertive" hidden></p></div>
    <div class="onboarding-footer">${stage !== "welcome" ? `<button class="btn" data-action="x-onboarding-back">Back</button>` : ""}<button class="act" data-action="x-onboarding-exit">${progress?.completed ? "Back to settings" : "Set up later"}</button><span class="field-hint">Progress saves after each step.</span></div>
  </section>`;
}

let saving = false;
export async function handleXOnboardingAction(action: string, root: ParentNode = document): Promise<{ handled: boolean; error?: string; completed?: boolean; launchX?: boolean }> {
  const actions = ["reopen", "back", "choose-jev", "choose-claude", "providers", "focus", "finish"].map((name) => `x-onboarding-${name}`);
  if (!actions.includes(action)) return { handled: false };
  if (saving) return { handled: true, error: "Setup is still saving." };
  const value = (id: string): string => (root.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "";
  const checked = (id: string): boolean => (root.querySelector(`#${id}`) as HTMLInputElement | null)?.checked === true;
  const showError = (message: string) => {
    const alert = root.querySelector<HTMLElement>("#x-onboarding-error");
    if (alert) { alert.textContent = message; alert.hidden = false; alert.scrollIntoView?.({ block: "nearest" }); }
    return { handled: true, error: message };
  };
  const input: XOnboardingInput = action === "x-onboarding-providers" ? {
    anthropicKey: value("onboarding-anthropic-key"), typesafeKey: value("onboarding-typesafe-key"),
    xConsent: checked("onboarding-x-consent"), jevConsent: checked("onboarding-jev-consent"),
  } : action === "x-onboarding-focus" ? { focus: value("onboarding-focus"), voice: value("onboarding-voice") } : {};
  saving = true;
  try {
    const store = await chrome.storage.local.get(null);
    const result = transitionXOnboarding(store, action, input);
    if (result.error) return showError(result.error);
    if (result.patch) await chrome.storage.local.set(result.patch);
    return { handled: true, completed: result.completed, launchX: result.launchX };
  } catch {
    return showError("Could not save your setup. Please try again.");
  } finally { saving = false; }
}
