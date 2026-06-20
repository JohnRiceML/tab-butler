import { NextResponse } from "next/server";

/**
 * CORS for the browser extension. The extension's Origin is
 * `chrome-extension://<id>`. For the scaffold we reflect the origin; before
 * production, lock this to your published extension id(s).
 *
 * TODO(prod): replace reflect-origin with an allowlist of your extension ids.
 */
const ALLOWED_ORIGIN_PREFIXES = ["chrome-extension://", "moz-extension://"];

export function corsHeaders(origin: string | null): Record<string, string> {
  const ok =
    origin != null &&
    ALLOWED_ORIGIN_PREFIXES.some((p) => origin.startsWith(p));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

export function json(
  body: unknown,
  status: number,
  origin: string | null,
): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

export function preflight(origin: string | null): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

/**
 * Placeholder auth gate. The managed tier must NOT spend tokens for
 * unauthenticated callers. Wire this to your existing session/JWT check
 * (e.g. the same auth your main app uses) before launch.
 */
export function isAuthorized(req: Request): boolean {
  // TODO(prod): verify a real bearer token / signed session here.
  const auth = req.headers.get("authorization");
  return Boolean(auth && auth.startsWith("Bearer "));
}
