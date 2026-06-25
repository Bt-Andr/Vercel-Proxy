/**
 * CORS handling for browser-based web fronts that call the proxy cross-origin.
 *
 * Mobile apps don't enforce CORS, so this is purely for web clients. We support
 * an allow-list (PROXY_ALLOWED_ORIGINS) or "*", and optional credentials.
 */

import type { Settings } from "./types";

/** Decide the Access-Control-Allow-Origin value for a given request origin. */
export function resolveAllowedOrigin(
  config: Settings,
  origin: string | null,
): string | null {
  if (config.allowedOrigins === "*") {
    // With credentials, "*" is illegal; reflect the caller's origin instead.
    if (config.allowCredentials) return origin ?? null;
    return "*";
  }
  if (origin && config.allowedOrigins.includes(origin)) return origin;
  return null;
}

/** Apply CORS headers in-place to an outgoing Headers object. */
export function applyCorsHeaders(
  headers: Headers,
  config: Settings,
  origin: string | null,
): void {
  const allowOrigin = resolveAllowedOrigin(config, origin);
  if (!allowOrigin) return;

  headers.set("access-control-allow-origin", allowOrigin);
  if (allowOrigin !== "*") headers.append("vary", "Origin");
  if (config.allowCredentials) {
    headers.set("access-control-allow-credentials", "true");
  }
}

/** Build a response to a CORS preflight (OPTIONS) request. */
export function buildPreflightResponse(
  request: Request,
  config: Settings,
): Response {
  const origin = request.headers.get("origin");
  const headers = new Headers();
  applyCorsHeaders(headers, config, origin);

  // Echo what the browser asked for; fall back to common defaults.
  const reqMethod = request.headers.get("access-control-request-method");
  const reqHeaders = request.headers.get("access-control-request-headers");
  headers.set(
    "access-control-allow-methods",
    reqMethod ?? "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
  );
  headers.set("access-control-allow-headers", reqHeaders ?? "*");
  headers.set("access-control-max-age", "86400");

  return new Response(null, { status: 204, headers });
}
