/**
 * Shared types for the proxy + admin layer.
 */

/** A single backend route record (the unit edited via the admin UI). */
export interface RouteRecord {
  /** App key, e.g. "app_x" — the path prefix / target identifier. */
  key: string;
  /** Backend base URL, e.g. "https://back-x.onrender.com" (no trailing slash). */
  target: string;
  /** Strip the `/<key>` prefix from the path before forwarding. Default true. */
  stripPrefix: boolean;
  /** Optional per-route shared secret required in the X-Proxy-Key header. */
  keySecret?: string;
  /** Optional per-route timeout override (ms). */
  timeoutMs?: number;
  /** Optional custom hostnames that resolve to this route. */
  hosts?: string[];
  /** When true the route is kept but not served (returns 404). */
  disabled?: boolean;
  /** ISO timestamp of the last update (set by the store). */
  updatedAt?: string;
}

/** Global, env-driven settings (not editable at runtime). */
export interface Settings {
  /** Global shared secret; when set, required on every proxied request. */
  globalKey?: string;
  /** Admin API token; when unset, the admin API/UI is disabled. */
  adminKey?: string;
  /** Allowed CORS origins, or "*". */
  allowedOrigins: string[] | "*";
  allowCredentials: boolean;
  /** Default upstream timeout (ms). */
  timeoutMs: number;
  /** Retries on network error for idempotent methods. */
  maxRetries: number;
  /** Lower-cased header name used to explicitly target a route key. */
  targetHeader: string;
  /** Seed routes parsed from env (used to bootstrap an empty store). */
  seedRoutes: RouteRecord[];
  /** Non-fatal problems found while parsing settings. */
  warnings: string[];
}

/** Settings + the currently active routes/hosts, assembled per request. */
export interface ResolvedConfig extends Settings {
  routes: Map<string, RouteRecord>;
  hosts: Map<string, string>;
  /** Which storage backend produced the routes ("memory" | "upstash"). */
  storage: string;
}
