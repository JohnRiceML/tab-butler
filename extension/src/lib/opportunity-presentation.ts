/** Display-only vocabulary and colors. Ranking thresholds stay with their callers. */
export type OpportunityTone = "top" | "good" | "low" | "attention" | "manual";
export type OpportunityTheme = "dark" | "light";

const COPY = {
  top: { label: "Top pick", description: "One of the strongest opportunities in your current queue." },
  good: { label: "Good option", description: "A worthwhile conversation with a useful contribution to make." },
  low: { label: "Lower priority", description: "Other conversations look stronger right now. This is not a reminder to reply later." },
  attention: { label: "Needs attention", description: "Check the context before drafting." },
  manual: { label: "Your pick", description: "You added this post. Goobi has not recommended it." },
} as const;

const PALETTES = {
  dark: {
    top: { bg: "#183527", fg: "#a7efbb", border: "#39784e", accent: "#89dda4" },
    good: { bg: "#192f49", fg: "#b3d9ff", border: "#42688c", accent: "#90c8ff" },
    low: { bg: "#292d33", fg: "#c3c8d0", border: "#555c65", accent: "#a1aab6" },
    attention: { bg: "#3d2a12", fg: "#f8d49a", border: "#926a36", accent: "#edbf77" },
    manual: { bg: "#292d33", fg: "#c3c8d0", border: "#555c65", accent: "#a1aab6" },
  },
  light: {
    top: { bg: "#e7f4eb", fg: "#205c38", border: "#a7cdb3", accent: "#318252" },
    good: { bg: "#eaf2fc", fg: "#24578b", border: "#aac6e5", accent: "#3977b8" },
    low: { bg: "#f0f2f4", fg: "#535e6b", border: "#c7cdd4", accent: "#707c89" },
    attention: { bg: "#fff2dd", fg: "#805016", border: "#dfbd85", accent: "#a76b20" },
    manual: { bg: "#f0f2f4", fg: "#535e6b", border: "#c7cdd4", accent: "#707c89" },
  },
} as const;

export function opportunityPresentation(tone: OpportunityTone, theme: OpportunityTheme = "dark") {
  return { tone, ...COPY[tone], ...PALETTES[theme][tone] };
}

export function replyPriorityTone(strength?: string): OpportunityTone {
  return strength === "best next" ? "top" : strength === "good option" ? "good" : "low";
}

export function replyConversationLabel(lane?: string): string {
  return lane === "inbound" ? "Replied to you"
    : lane === "continue" ? "Keep talking"
      : lane === "community" ? "Connect with a peer"
        : "New conversation";
}
