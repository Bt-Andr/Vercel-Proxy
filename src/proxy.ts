/**
 * Core reverse-proxy handler (runtime-agnostic Web fetch handler).
 *
 * Flow: parse original path -> internal endpoints -> auth -> CORS preflight ->
 * resolve backend -> stream request upstream (timeout + retry) -> stream
 * response back with clean headers + CORS.
 */

import type { ResolvedConfig, RouteRecord, Settings } from "./types";
import { resolveConfig, getStore } from "./store";
import { resolveRoute, type IncomingRequest } from "./router";
import { buildUpstreamHeaders, buildDownstreamHeaders } from "./headers";
import { applyCorsHeaders, buildPreflightResponse } from "./cors";
import { handleAdmin } from "./admin";
import { safeEqual } from "./util";

/** Methods we'll safely retry (idempotent and bodyless). */
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** RequestInit augmented with the streaming-body flag Node's fetch requires. */
type FetchInit = RequestInit & { duplex?: "half" };

interface ParsedPath {
  pathname: string;
  search: string;
}

/**
 * Recover the ORIGINAL request path/query, regardless of whether Vercel's
 * rewrite kept the visible URL or collapsed it onto /api/proxy.
 *
 * Primary source is `url.pathname` (correctly encoded). If that has been
 * rewritten to the function path, fall back to the `__path` query injected by
 * the rewrite in vercel.json.
 */
export function parseOriginalPath(url: URL): ParsedPath {
  const params = new URLSearchParams(url.search);
  const override = params.get("__path");
  params.delete("__path");

  const cleanedSearch = params.toString();
  const search = cleanedSearch ? `?${cleanedSearch}` : "";

  let pathname = url.pathname;
  if (pathname === "/api/proxy" || pathname === "/api/proxy/") {
    pathname = "/" + (override ?? "").replace(/^\/+/, "");
  }
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return { pathname, search };
}

function jsonResponse(
  body: unknown,
  status: number,
  config: Settings,
  origin: string | null,
  extraHeaders?: Headers,
): Response {
  const headers = extraHeaders ?? new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-proxy", "vercel-dynamic-proxy");
  applyCorsHeaders(headers, config, origin);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Read the supplied proxy key from header or query. */
function readProvidedKey(request: Request, url: URL): string | undefined {
  return (
    request.headers.get("x-proxy-key") ??
    url.searchParams.get("__key") ??
    undefined
  );
}

function getClientIp(request: Request): string | undefined {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim();
  return request.headers.get("x-real-ip") ?? undefined;
}

/** Internal diagnostics endpoints under /__proxy/*. */
function handleInternal(
  pathname: string,
  request: Request,
  url: URL,
  config: ResolvedConfig,
  origin: string | null,
): Response | undefined {
  if (pathname === "/__proxy/health" || pathname === "/") {
    const ephemeral = getStore(config).ephemeral;
    const warnings = [...config.warnings];
    if (ephemeral && process.env.VERCEL) {
      warnings.push(
        "Using the ephemeral in-memory store on Vercel: route edits won't " +
          "persist across instances/redeploys. Connect Upstash Redis " +
          "(UPSTASH_REDIS_REST_URL / _TOKEN) for production.",
      );
    }
    return jsonResponse(
      {
        status: "ok",
        service: "vercel-dynamic-proxy",
        storage: config.storage,
        adminEnabled: Boolean(config.adminKey),
        routeCount: config.routes.size,
        routes: [...config.routes.keys()],
        hostAliases: [...config.hosts.keys()],
        warnings,
      },
      config.routes.size === 0 ? 503 : 200,
      config,
      origin,
    );
  }

  if (pathname === "/__proxy/routes") {
    // Full mapping (incl. targets) requires the global key when one is set.
    if (config.globalKey) {
      const provided = readProvidedKey(request, url);
      if (!provided || !safeEqual(provided, config.globalKey)) {
        return jsonResponse(
          { error: "unauthorized", message: "Valid X-Proxy-Key required." },
          401,
          config,
          origin,
        );
      }
    }
    const routes = [...config.routes.values()].map((r) => ({
      key: r.key,
      target: r.target,
      stripPrefix: r.stripPrefix,
      hasKey: Boolean(r.keySecret),
    }));
    return jsonResponse(
      { routes, hosts: Object.fromEntries(config.hosts) },
      200,
      config,
      origin,
    );
  }

  return undefined;
}

/** Verify the global and per-route shared secrets, if configured. */
function checkAuth(
  request: Request,
  url: URL,
  config: Settings,
  route: RouteRecord | undefined,
): { ok: true } | { ok: false; message: string } {
  const provided = readProvidedKey(request, url);

  if (config.globalKey) {
    if (!provided || !safeEqual(provided, config.globalKey)) {
      return { ok: false, message: "Valid X-Proxy-Key required." };
    }
  }
  if (route?.keySecret) {
    if (!provided || !safeEqual(provided, route.keySecret)) {
      return { ok: false, message: `Valid X-Proxy-Key required for "${route.key}".` };
    }
  }
  return { ok: true };
}

/** Perform the upstream fetch with a timeout and bounded retries. */
async function fetchUpstream(
  targetUrl: string,
  init: FetchInit,
  timeoutMs: number,
  maxRetries: number,
  method: string,
): Promise<Response> {
  const canRetry = RETRYABLE_METHODS.has(method);
  const attempts = canRetry ? maxRetries + 1 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(targetUrl, { ...init, signal: controller.signal });
    } catch (err) {
      lastError = err;
      // Abort = timeout: don't hammer a slow/cold backend, fail fast.
      if (controller.signal.aborted) throw err;
      // Network error: retry idempotent requests after a short backoff.
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function handleProxy(request: Request): Promise<Response> {
  const config = await resolveConfig();
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const { pathname, search } = parseOriginalPath(url);

  // Admin API + UI (token-protected, disabled when ADMIN_KEY is unset).
  if (pathname === "/__admin" || pathname.startsWith("/__proxy/admin")) {
    return handleAdmin(request, pathname, config);
  }

  // Internal endpoints (health/routes) — never proxied.
  const internal = handleInternal(pathname, request, url, config, origin);
  if (internal) return internal;

  // CORS preflight is answered locally so the browser never blocks the call.
  if (request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
    return buildPreflightResponse(request, config);
  }

  // Resolve which backend this request targets.
  const incoming: IncomingRequest = {
    host: request.headers.get("host") ?? url.host,
    pathname,
    search,
    targetHeaderValue: request.headers.get(config.targetHeader) ?? undefined,
  };
  const resolution = resolveRoute(config, incoming);
  if (!resolution.ok) {
    return jsonResponse(
      { error: resolution.code, message: resolution.message },
      resolution.status,
      config,
      origin,
    );
  }
  const { route, targetUrl } = resolution;

  // Authentication (global + per-route shared secret).
  const auth = checkAuth(request, url, config, route);
  if (!auth.ok) {
    return jsonResponse({ error: "unauthorized", message: auth.message }, 401, config, origin);
  }

  // Build the upstream request.
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const upstreamHeaders = buildUpstreamHeaders(
    request.headers,
    config.targetHeader,
    incoming.host,
    proto,
    getClientIp(request),
  );

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: FetchInit = {
    method,
    headers: upstreamHeaders,
    redirect: "manual", // forward redirects to the client transparently
  };
  if (hasBody) {
    init.body = request.body;
    init.duplex = "half";
  }

  const timeoutMs = route.timeoutMs ?? config.timeoutMs;

  let upstream: Response;
  try {
    upstream = await fetchUpstream(targetUrl, init, timeoutMs, config.maxRetries, method);
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return jsonResponse(
      {
        error: aborted ? "upstream_timeout" : "upstream_unreachable",
        message: aborted
          ? `Backend "${route.key}" did not respond within ${timeoutMs}ms.`
          : `Could not reach backend "${route.key}".`,
        target: route.key,
      },
      aborted ? 504 : 502,
      config,
      origin,
    );
  }

  // Stream the response back with cleaned headers + CORS.
  const headers = buildDownstreamHeaders(upstream.headers);
  headers.set("x-proxy", "vercel-dynamic-proxy");
  headers.set("x-proxy-target", route.key);
  applyCorsHeaders(headers, config, origin);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
