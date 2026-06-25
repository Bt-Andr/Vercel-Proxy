/**
 * Route resolution: decide which backend a given incoming request targets.
 *
 * Resolution order (first match wins):
 *   1. Explicit target header  (X-Proxy-Target: app_x)      -> path forwarded as-is
 *   2. Host mapping            (api-x.example.com -> app_x)  -> path forwarded as-is
 *   3. Path prefix             (/app_x/...)                  -> /app_x stripped by default
 *
 * Pure module: no I/O, fully unit-testable.
 */

import type { ResolvedConfig, RouteRecord } from "./types.js";

export interface IncomingRequest {
  /** Host header, lower-cased (may include a port). */
  host: string;
  /** Original incoming pathname, e.g. "/app_x/api/users". */
  pathname: string;
  /** Original query string including leading "?", or "". */
  search: string;
  /** Value of the configured target header, if present. */
  targetHeaderValue?: string;
}

export type Resolution =
  | {
      ok: true;
      route: RouteRecord;
      targetUrl: string;
      matchedBy: "header" | "host" | "path";
    }
  | { ok: false; status: number; code: string; message: string };

/** Strip an optional port and lower-case a host value. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, "").trim();
}

/** Build the final upstream URL from a route, a forward path and a query string. */
function buildTargetUrl(route: RouteRecord, forwardPath: string, search: string): string {
  let path = forwardPath;
  if (!path.startsWith("/")) path = "/" + path;
  return route.target + path + search;
}

/** Split "/app_x/api/users" -> ["app_x", "/api/users"]. */
function splitFirstSegment(pathname: string): [string, string] {
  // Drop the leading slash, find the next one.
  const withoutLeading = pathname.replace(/^\/+/, "");
  const slash = withoutLeading.indexOf("/");
  if (slash === -1) {
    return [decodeURIComponent(withoutLeading), "/"];
  }
  const first = withoutLeading.slice(0, slash);
  const rest = withoutLeading.slice(slash); // keeps leading slash
  return [decodeURIComponent(first), rest];
}

export function resolveRoute(config: ResolvedConfig, req: IncomingRequest): Resolution {
  // 1. Explicit target header.
  const headerKey = req.targetHeaderValue?.trim();
  if (headerKey) {
    const route = config.routes.get(headerKey);
    if (!route) {
      return {
        ok: false,
        status: 404,
        code: "unknown_target",
        message: `No route configured for target "${headerKey}".`,
      };
    }
    return {
      ok: true,
      route,
      matchedBy: "header",
      targetUrl: buildTargetUrl(route, req.pathname || "/", req.search),
    };
  }

  // 2. Host mapping.
  const host = normalizeHost(req.host);
  const hostKey = config.hosts.get(host);
  if (hostKey) {
    const route = config.routes.get(hostKey);
    if (!route) {
      return {
        ok: false,
        status: 500,
        code: "misconfigured_host",
        message: `Host "${host}" maps to "${hostKey}", which has no route.`,
      };
    }
    return {
      ok: true,
      route,
      matchedBy: "host",
      targetUrl: buildTargetUrl(route, req.pathname || "/", req.search),
    };
  }

  // 3. Path prefix.
  const [firstSegment, rest] = splitFirstSegment(req.pathname);
  if (firstSegment) {
    const route = config.routes.get(firstSegment);
    if (route) {
      const forwardPath = route.stripPrefix ? rest : req.pathname;
      return {
        ok: true,
        route,
        matchedBy: "path",
        targetUrl: buildTargetUrl(route, forwardPath, req.search),
      };
    }
  }

  return {
    ok: false,
    status: 404,
    code: "no_route",
    message:
      `Could not resolve a backend for "${req.pathname}". ` +
      `Use a path prefix (/<appKey>/...), the "${config.targetHeader}" header, ` +
      `or a configured host.`,
  };
}
