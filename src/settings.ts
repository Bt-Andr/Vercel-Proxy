/**
 * Parse global settings + seed routes from environment variables.
 *
 * Routes are now stored in a mutable backend (see store.ts) and edited via the
 * admin UI, but env-defined routes are still honoured as a *seed* to bootstrap
 * an empty store and as a zero-dependency fallback for local dev.
 */

import type { Settings, RouteRecord } from "./types.js";

export type Env = Record<string, string | undefined>;

const DEFAULT_TIMEOUT_MS = 55_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_TARGET_HEADER = "x-proxy-target";

function normalizeTarget(url: string): string {
  return url.replace(/\/+$/, "");
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Build a RouteRecord from a raw value (string URL or object), or null. */
export function makeRoute(
  key: string,
  raw: unknown,
  warnings: string[],
): RouteRecord | null {
  const normKey = key.trim();
  if (!normKey) return null;

  if (typeof raw === "string") {
    if (!isValidHttpUrl(raw)) {
      warnings.push(`Route "${normKey}" has an invalid target URL: ${raw}`);
      return null;
    }
    return { key: normKey, target: normalizeTarget(raw), stripPrefix: true };
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const target = typeof obj.target === "string" ? obj.target : "";
    if (!isValidHttpUrl(target)) {
      warnings.push(`Route "${normKey}" has an invalid or missing target URL.`);
      return null;
    }
    return {
      key: normKey,
      target: normalizeTarget(target),
      stripPrefix: obj.stripPrefix === undefined ? true : Boolean(obj.stripPrefix),
      keySecret: typeof obj.keySecret === "string" ? obj.keySecret : undefined,
      timeoutMs:
        typeof obj.timeoutMs === "number" && obj.timeoutMs > 0 ? obj.timeoutMs : undefined,
      hosts: Array.isArray(obj.hosts)
        ? obj.hosts.filter((h): h is string => typeof h === "string")
        : undefined,
      disabled: obj.disabled === undefined ? undefined : Boolean(obj.disabled),
    };
  }

  warnings.push(`Route "${normKey}" has an unsupported value type.`);
  return null;
}

/** Parse seed routes from PROXY_ROUTES (JSON) and ROUTE_<KEY> variables. */
export function parseSeedRoutes(env: Env, warnings: string[]): RouteRecord[] {
  const records = new Map<string, RouteRecord>();

  const json = env.PROXY_ROUTES?.trim();
  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          const r = makeRoute(key, value, warnings);
          if (r) records.set(r.key, r);
        }
      } else {
        warnings.push("PROXY_ROUTES must be a JSON object mapping app keys to targets.");
      }
    } catch (err) {
      warnings.push(`PROXY_ROUTES is not valid JSON: ${(err as Error).message}`);
    }
  }

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("ROUTE_") || !value) continue;
    const r = makeRoute(name.slice("ROUTE_".length).toLowerCase(), value, warnings);
    if (r) records.set(r.key, r);
  }

  return [...records.values()];
}

function parseOrigins(env: Env): string[] | "*" {
  const raw = env.PROXY_ALLOWED_ORIGINS?.trim();
  if (!raw || raw === "*") return "*";
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function parseSettings(env: Env): Settings {
  const warnings: string[] = [];
  const seedRoutes = parseSeedRoutes(env, warnings);

  return {
    globalKey: env.PROXY_GLOBAL_KEY?.trim() || undefined,
    adminKey: env.ADMIN_KEY?.trim() || undefined,
    allowedOrigins: parseOrigins(env),
    allowCredentials: /^(1|true|yes)$/i.test(env.PROXY_ALLOW_CREDENTIALS?.trim() ?? ""),
    timeoutMs: parsePositiveInt(env.PROXY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRetries: parsePositiveInt(env.PROXY_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    targetHeader: (env.PROXY_TARGET_HEADER?.trim() || DEFAULT_TARGET_HEADER).toLowerCase(),
    seedRoutes,
    warnings,
  };
}

let cached: { env: Env; settings: Settings } | undefined;

export function getSettings(env: Env = process.env): Settings {
  if (cached && cached.env === env) return cached.settings;
  const settings = parseSettings(env);
  cached = { env, settings };
  return settings;
}

export function resetSettingsCache(): void {
  cached = undefined;
}
