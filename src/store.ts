/**
 * Mutable route storage with a pluggable backend + a short-lived hot-path cache.
 *
 *   source of truth  ──►  TTL cache (per warm instance)  ──►  resolveConfig()
 *
 * Backends:
 *   - MemoryStore  : in-process, seeded from env. For local dev & tests.
 *                    EPHEMERAL — each serverless instance has its own copy and
 *                    it resets on redeploy, so it must not be the prod store.
 *   - UpstashStore : Upstash Redis over its REST API (a single token, immediate
 *                    writes). The recommended production backend.
 *
 * The backend is chosen automatically from the environment; env-defined routes
 * seed an empty Upstash store on first read.
 */

import type { RouteRecord, ResolvedConfig, Settings } from "./types.js";
import { getSettings, resetSettingsCache, type Env } from "./settings.js";

const HASH_KEY = "proxy:routes";
const CACHE_TTL_MS = 30_000;

export interface RouteStore {
  /** Backend identifier surfaced on the health endpoint. */
  readonly kind: string;
  /** True when the data does not survive instance recycling / redeploys. */
  readonly ephemeral: boolean;
  list(): Promise<RouteRecord[]>;
  put(record: RouteRecord): Promise<void>;
  remove(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Memory backend
// ---------------------------------------------------------------------------

export class MemoryStore implements RouteStore {
  readonly kind = "memory";
  readonly ephemeral = true;
  private readonly records = new Map<string, RouteRecord>();

  constructor(seed: RouteRecord[] = []) {
    for (const r of seed) this.records.set(r.key, r);
  }

  async list(): Promise<RouteRecord[]> {
    return [...this.records.values()];
  }

  async put(record: RouteRecord): Promise<void> {
    this.records.set(record.key, record);
  }

  async remove(key: string): Promise<boolean> {
    return this.records.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Upstash Redis (REST) backend
// ---------------------------------------------------------------------------

export class UpstashStore implements RouteStore {
  readonly kind = "upstash";
  readonly ephemeral = false;
  private seeded = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly seed: RouteRecord[] = [],
  ) {}

  private async cmd(args: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      throw new Error(`Upstash ${String(args[0])} failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { result?: unknown; error?: string };
    if (data.error) throw new Error(`Upstash error: ${data.error}`);
    return data.result;
  }

  async list(): Promise<RouteRecord[]> {
    const flat = (await this.cmd(["HGETALL", HASH_KEY])) as string[] | null;
    const records: RouteRecord[] = [];
    if (Array.isArray(flat)) {
      for (let i = 0; i + 1 < flat.length; i += 2) {
        try {
          records.push(JSON.parse(flat[i + 1] as string) as RouteRecord);
        } catch {
          // skip corrupt entries rather than failing the whole proxy
        }
      }
    }

    // Bootstrap an empty store from env-defined seed routes (once).
    if (records.length === 0 && this.seed.length > 0 && !this.seeded) {
      this.seeded = true;
      const args: (string | number)[] = ["HSET", HASH_KEY];
      for (const r of this.seed) args.push(r.key, JSON.stringify(r));
      await this.cmd(args);
      return this.seed;
    }
    return records;
  }

  async put(record: RouteRecord): Promise<void> {
    await this.cmd(["HSET", HASH_KEY, record.key, JSON.stringify(record)]);
  }

  async remove(key: string): Promise<boolean> {
    const removed = (await this.cmd(["HDEL", HASH_KEY, key])) as number;
    return Number(removed) > 0;
  }
}

// ---------------------------------------------------------------------------
// Backend selection + hot-path cache + composition
// ---------------------------------------------------------------------------

let storeInstance: RouteStore | undefined;
let cacheState: { records: RouteRecord[]; expires: number } | undefined;

export function getStore(settings: Settings = getSettings(), env: Env = process.env): RouteStore {
  if (storeInstance) return storeInstance;
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  storeInstance =
    url && token
      ? new UpstashStore(url, token, settings.seedRoutes)
      : new MemoryStore(settings.seedRoutes);
  return storeInstance;
}

/** Read records through the TTL cache. */
async function getCachedRecords(store: RouteStore): Promise<RouteRecord[]> {
  const now = Date.now();
  if (cacheState && cacheState.expires > now) return cacheState.records;
  const records = await store.list();
  cacheState = { records, expires: now + CACHE_TTL_MS };
  return records;
}

/** Drop the hot-path cache (call right after a write). */
export function invalidateRouteCache(): void {
  cacheState = undefined;
}

/** Assemble settings + the currently active routes/hosts for a request. */
export async function resolveConfig(env: Env = process.env): Promise<ResolvedConfig> {
  const settings = getSettings(env);
  const store = getStore(settings, env);
  const records = await getCachedRecords(store);

  const routes = new Map<string, RouteRecord>();
  const hosts = new Map<string, string>();
  for (const record of records) {
    if (record.disabled) continue;
    routes.set(record.key, record);
    for (const host of record.hosts ?? []) {
      hosts.set(host.toLowerCase().trim(), record.key);
    }
  }

  return { ...settings, routes, hosts, storage: store.kind };
}

/** Test/runtime helper: clear store instance + settings + route caches. */
export function resetConfigCache(): void {
  storeInstance = undefined;
  cacheState = undefined;
  resetSettingsCache();
}
