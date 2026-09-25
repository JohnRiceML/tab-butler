import { CONFIG } from "./config";

export type OnboardingStage = "welcome" | "providers" | "focus" | "finish";
export type OnboardingProvider = "jev" | "claude";
export type OnboardingStore = Record<string, unknown>;
export interface XOnboardingProgress {
  version: 1;
  stage: OnboardingStage;
  provider?: OnboardingProvider;
  completed: boolean;
}
export interface XOnboardingInput {
  anthropicKey?: string;
  typesafeKey?: string;
  xConsent?: boolean;
  jevConsent?: boolean;
  focus?: string;
  voice?: string;
}
export interface XOnboardingTransition {
  patch?: OnboardingStore;
  error?: string;
  completed?: boolean;
  launchX?: boolean;
}

const stages: OnboardingStage[] = ["welcome", "providers", "focus", "finish"];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/** Only these small navigation fields belong in onboarding metadata. Keys stay in their existing settings. */
export function onboardingProgress(store: OnboardingStore): XOnboardingProgress | null {
  const raw = store[CONFIG.X_ONBOARDING_KEY];
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !stages.includes(value.stage as OnboardingStage)) return null;
  return {
    version: 1,
    stage: value.stage as OnboardingStage,
    ...(value.provider === "jev" || value.provider === "claude" ? { provider: value.provider } : {}),
    completed: value.completed === true,
  };
}

export function onboardingProvidersReady(store: OnboardingStore): boolean {
  return Boolean(text(store[CONFIG.ANTHROPIC_KEY_KEY])) && store[CONFIG.X_DATA_CONSENT_KEY] === "v1"
    && (store[CONFIG.ANALYSIS_PROVIDER_KEY] !== "jev"
      || (Boolean(text(store[CONFIG.TYPESAFE_KEY_KEY])) && store[CONFIG.JEV_ANALYSIS_CONSENT_KEY] === "v1"));
}

export function isXOnboardingConfigured(store: OnboardingStore): boolean {
  return onboardingProvidersReady(store) && Boolean(text(store[CONFIG.X_NICHE_KEY]));
}

export function shouldShowXOnboarding(store: OnboardingStore): boolean {
  const progress = onboardingProgress(store);
  return Boolean(progress && !progress.completed) || !isXOnboardingConfigured(store);
}

export function onboardingStage(store: OnboardingStore): OnboardingStage {
  const progress = onboardingProgress(store);
  if (!progress) return "welcome";
  if (progress.stage !== "welcome" && !progress.provider) return "welcome";
  if ((progress.stage === "focus" || progress.stage === "finish") && !onboardingProvidersReady(store)) return "providers";
  if (progress.stage === "finish" && !text(store[CONFIG.X_NICHE_KEY])) return "focus";
  return progress.stage;
}

/** Pure validation and patches: no calls, no UI, no implicit consent, no reviewer opt-in. */
export function transitionXOnboarding(store: OnboardingStore, action: string, input: XOnboardingInput = {}): XOnboardingTransition {
  const previous = onboardingProgress(store);
  const stage = onboardingStage(store);
  const progress = (next: OnboardingStage, provider = previous?.provider): XOnboardingProgress => ({
    version: 1, stage: next, ...(provider ? { provider } : {}), completed: false,
  });
  if (action === "x-onboarding-reopen") {
    return { patch: { [CONFIG.X_ONBOARDING_KEY]: progress("welcome", store[CONFIG.ANALYSIS_PROVIDER_KEY] === "jev" ? "jev" : "claude") } };
  }
  if (action === "x-onboarding-back") {
    return { patch: { [CONFIG.X_ONBOARDING_KEY]: progress(stages[Math.max(0, stages.indexOf(stage) - 1)]) } };
  }
  if (action === "x-onboarding-choose-jev" || action === "x-onboarding-choose-claude") {
    return { patch: { [CONFIG.X_ONBOARDING_KEY]: progress("providers", action.endsWith("jev") ? "jev" : "claude") } };
  }
  if (action === "x-onboarding-providers") {
    const provider = previous?.provider;
    if (stage !== "providers" || !provider) return { error: "Choose Jev or Claude-only first." };
    const anthropicKey = text(input.anthropicKey) || text(store[CONFIG.ANTHROPIC_KEY_KEY]);
    const typesafeKey = text(input.typesafeKey) || text(store[CONFIG.TYPESAFE_KEY_KEY]);
    if (!anthropicKey) return { error: "Add an Anthropic API key for Claude drafts." };
    if (provider === "jev" && !typesafeKey) return { error: "Add a TypeSafe API key for Jev analysis, or go back and choose Claude-only." };
    if (store[CONFIG.X_DATA_CONSENT_KEY] !== "v1" && input.xConsent !== true) return { error: "Read the X data disclosure and check its agreement box to continue." };
    if (provider === "jev" && store[CONFIG.JEV_ANALYSIS_CONSENT_KEY] !== "v1" && input.jevConsent !== true) return { error: "Read the Jev data disclosure and check its separate agreement box to continue." };
    return { patch: {
      ...(text(input.anthropicKey) ? { [CONFIG.ANTHROPIC_KEY_KEY]: anthropicKey } : {}),
      ...(provider === "jev" && text(input.typesafeKey) ? { [CONFIG.TYPESAFE_KEY_KEY]: typesafeKey } : {}),
      [CONFIG.ANALYSIS_PROVIDER_KEY]: provider,
      [CONFIG.X_DATA_CONSENT_KEY]: "v1",
      ...(provider === "jev" ? { [CONFIG.JEV_ANALYSIS_CONSENT_KEY]: "v1" } : {}),
      // The runtime defaults on unless false. Consent + keys must never start scans midway through setup.
      [CONFIG.X_COPILOT_KEY]: false,
      [CONFIG.X_ONBOARDING_KEY]: progress("focus", provider),
    } };
  }
  if (action === "x-onboarding-focus") {
    if (stage !== "focus" || !onboardingProvidersReady(store)) return { error: "Finish connecting your providers first." };
    const focus = text(input.focus);
    if (!focus) return { error: "Add at least one topic or kind of conversation you want to join." };
    if (focus.length > 2000) return { error: "Keep your focus under 2,000 characters." };
    if ((input.voice ?? "").length > 6000) return { error: "Keep your voice notes under 6,000 characters." };
    return { patch: {
      [CONFIG.X_NICHE_KEY]: focus,
      ...(input.voice !== undefined ? { [CONFIG.X_VOICE_KEY]: input.voice.trim() } : {}),
      [CONFIG.X_ONBOARDING_KEY]: progress("finish"),
    } };
  }
  if (action === "x-onboarding-finish") {
    if (stage !== "finish" || !previous?.provider || !isXOnboardingConfigured(store)) return { error: "Finish your provider connection and focus before enabling Goobi." };
    if ((store[CONFIG.ANALYSIS_PROVIDER_KEY] === "jev" ? "jev" : "claude") !== previous.provider) return { error: "Your provider changed in another window. Go back and review your connection." };
    return { patch: {
      [CONFIG.X_COPILOT_KEY]: true,
      [CONFIG.X_PAUSED_KEY]: false,
      [CONFIG.X_ONBOARDING_KEY]: { ...progress("finish"), completed: true },
    }, completed: true, launchX: true };
  }
  return {};
}
