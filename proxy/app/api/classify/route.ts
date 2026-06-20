import type { NextRequest } from "next/server";

import { classifyTabs } from "@/lib/claude";
import { isAuthorized, json, preflight } from "@/lib/http";
import { ClassifyRequest } from "@/lib/schemas";

// Node runtime — the Anthropic SDK needs Node, not edge.
export const runtime = "nodejs";
export const maxDuration = 60;

export function OPTIONS(req: NextRequest) {
  return preflight(req.headers.get("origin"));
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");

  if (!isAuthorized(req)) {
    return json({ error: "unauthorized" }, 401, origin);
  }

  const parsed = ClassifyRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "invalid request", issues: parsed.error.issues }, 400, origin);
  }

  // Privacy: only id/title/url/idle ever reach this route — never page content.
  if (parsed.data.tabs.length === 0) {
    return json({ groups: [] }, 200, origin);
  }

  try {
    const result = await classifyTabs(parsed.data.tabs);
    return json(result, 200, origin);
  } catch (err) {
    console.error("classify failed", err);
    return json({ error: "classify failed" }, 502, origin);
  }
}
