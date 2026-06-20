import type { NextRequest } from "next/server";

import { adviseCleanup } from "@/lib/claude";
import { isAuthorized, json, preflight } from "@/lib/http";
import { AdviseRequest } from "@/lib/schemas";

export const runtime = "nodejs";
export const maxDuration = 120;

export function OPTIONS(req: NextRequest) {
  return preflight(req.headers.get("origin"));
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");

  if (!isAuthorized(req)) {
    return json({ error: "unauthorized" }, 401, origin);
  }

  const parsed = AdviseRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "invalid request", issues: parsed.error.issues }, 400, origin);
  }

  if (parsed.data.tabs.length === 0) {
    return json({ summary: "Nothing open to review.", recommendations: [] }, 200, origin);
  }

  try {
    const result = await adviseCleanup(parsed.data);
    return json(result, 200, origin);
  } catch (err) {
    console.error("advise failed", err);
    return json({ error: "advise failed" }, 502, origin);
  }
}
