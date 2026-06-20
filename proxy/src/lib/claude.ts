import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  AdviceResult,
  ClassifyResult,
  type AdviseRequest,
  type ClassifyResult as ClassifyResultType,
  type AdviceResult as AdviceResultType,
  type TabInput,
} from "./schemas";
import { ADVISE_SYSTEM, CLASSIFY_SYSTEM } from "./prompts";

// Reads ANTHROPIC_API_KEY from the environment. Never ship this key to the client.
const client = new Anthropic();

// Cheap, fast workhorse for high-volume classification/labeling.
const CLASSIFY_MODEL = "claude-haiku-4-5";
// Judgment pass — runs at most once a day per user, so the cost is worth it.
const ADVISE_MODEL = "claude-opus-4-8";

function tabsToText(tabs: TabInput[]): string {
  return tabs
    .map(
      (t) =>
        `#${t.id} | idle ${t.lastAccessedMinutes ?? "?"}m | ${t.title} | ${t.url}`,
    )
    .join("\n");
}

/**
 * Classify open tabs into named, color-coded groups. One Haiku call, structured
 * JSON out. The taxonomy lives in the cached system prompt; only the tab list
 * (volatile) goes in the user turn.
 */
export async function classifyTabs(
  tabs: TabInput[],
): Promise<ClassifyResultType> {
  const res = await client.messages.parse({
    model: CLASSIFY_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: CLASSIFY_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Organize these ${tabs.length} tabs into groups:\n\n${tabsToText(
          tabs,
        )}`,
      },
    ],
    output_config: { format: zodOutputFormat(ClassifyResult) },
  });

  if (!res.parsed_output) {
    throw new Error("classifyTabs: model returned no parseable output");
  }
  return res.parsed_output;
}

/**
 * The cleanup advisor. Reasons over tabs + idle + localhost + memory pressure
 * and returns a short ranked list of safe, reversible actions. Opus 4.8 with
 * adaptive thinking — structured output works alongside thinking.
 */
export async function adviseCleanup(
  input: AdviseRequest,
): Promise<AdviceResultType> {
  const localhostLines =
    input.localhost && input.localhost.length
      ? "\n\nRunning localhost dev servers:\n" +
        input.localhost
          .map(
            (s) =>
              `:${s.port} | ${s.title ?? "(unknown)"} | idle ${
                s.idleMinutes ?? "?"
              }m`,
          )
          .join("\n")
      : "";

  const memLine =
    input.systemMemoryUsedPct != null
      ? `\n\nSystem memory used: ${Math.round(input.systemMemoryUsedPct)}%`
      : "";

  const res = await client.messages.parse({
    model: ADVISE_MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    system: [
      { type: "text", text: ADVISE_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `Tabs:\n${tabsToText(input.tabs)}${localhostLines}${memLine}`,
      },
    ],
    output_config: { format: zodOutputFormat(AdviceResult) },
  });

  if (!res.parsed_output) {
    throw new Error("adviseCleanup: model returned no parseable output");
  }
  return res.parsed_output;
}
