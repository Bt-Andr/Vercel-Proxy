import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSettings, parseSeedRoutes, type Env } from "../src/settings";
import { resolveRoute, normalizeHost, type IncomingRequest } from "../src/router";
import { parseOriginalPath } from "../src/proxy";
import type { ResolvedConfig, RouteRecord } from "../src/types";

/** Build a ResolvedConfig from env the same way resolveConfig() does. */
function resolved(env: Env): ResolvedConfig {
  const s = parseSettings(env);
  const routes = new Map<string, RouteRecord>();
  const hosts = new Map<string, string>();
  for (const r of s.seedRoutes) {
    if (r.disabled) continue;
    routes.set(r.key, r);
    for (const h of r.hosts ?? []) hosts.set(h.toLowerCase(), r.key);
  }
  return { ...s, routes, hosts, storage: "memory" };
}

function req(partial: Partial<IncomingRequest>): IncomingRequest {
  return {
    host: "proxy.example.com",
    pathname: "/",
    search: "",
    targetHeaderValue: undefined,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// settings + seed-route parsing
// ---------------------------------------------------------------------------

test("seed routes: string + object forms", () => {
  const env: Env = {
    PROXY_ROUTES: JSON.stringify({
      app_x: "https://back-x.onrender.com/",
      app_y: { target: "https://back-y.onrender.com", stripPrefix: false, keySecret: "s3cr3t" },
    }),
  };
  const routes = new Map(parseSeedRoutes(env, []).map((r) => [r.key, r]));
  assert.equal(routes.size, 2);
  assert.equal(routes.get("app_x")?.target, "https://back-x.onrender.com"); // trailing slash trimmed
  assert.equal(routes.get("app_x")?.stripPrefix, true);
  assert.equal(routes.get("app_y")?.stripPrefix, false);
  assert.equal(routes.get("app_y")?.keySecret, "s3cr3t");
});

test("seed routes: ROUTE_<KEY> individual variables", () => {
  const routes = parseSeedRoutes({ ROUTE_APP_X: "https://back-x.onrender.com" }, []);
  assert.equal(routes[0]?.key, "app_x");
  assert.equal(routes[0]?.target, "https://back-x.onrender.com");
});

test("seed routes: invalid target produces a warning, not a route", () => {
  const warnings: string[] = [];
  const routes = parseSeedRoutes({ PROXY_ROUTES: JSON.stringify({ bad: "not-a-url" }) }, warnings);
  assert.equal(routes.length, 0);
  assert.ok(warnings.some((w) => w.includes("bad")));
});

test("settings: invalid JSON is reported", () => {
  const s = parseSettings({ PROXY_ROUTES: "{not json" });
  assert.ok(s.warnings.some((w) => w.includes("not valid JSON")));
});

test("settings: cors, admin and numeric options", () => {
  const s = parseSettings({
    PROXY_ALLOWED_ORIGINS: "https://a.com, https://b.com",
    PROXY_TIMEOUT_MS: "12345",
    PROXY_MAX_RETRIES: "3",
    PROXY_ALLOW_CREDENTIALS: "true",
    ADMIN_KEY: "admintoken",
  });
  assert.deepEqual(s.allowedOrigins, ["https://a.com", "https://b.com"]);
  assert.equal(s.timeoutMs, 12345);
  assert.equal(s.maxRetries, 3);
  assert.equal(s.allowCredentials, true);
  assert.equal(s.adminKey, "admintoken");
});

// ---------------------------------------------------------------------------
// route resolution
// ---------------------------------------------------------------------------

const baseCfg = resolved({
  PROXY_ROUTES: JSON.stringify({
    app_x: { target: "https://back-x.onrender.com", hosts: ["api-x.example.com"] },
    app_y: { target: "https://back-y.onrender.com", stripPrefix: false },
  }),
});

test("resolve: path prefix strips the key by default", () => {
  const r = resolveRoute(baseCfg, req({ pathname: "/app_x/api/users", search: "?a=1" }));
  assert.ok(r.ok);
  assert.equal(r.matchedBy, "path");
  assert.equal(r.targetUrl, "https://back-x.onrender.com/api/users?a=1");
});

test("resolve: path prefix keeps full path when stripPrefix=false", () => {
  const r = resolveRoute(baseCfg, req({ pathname: "/app_y/api/users" }));
  assert.ok(r.ok);
  assert.equal(r.targetUrl, "https://back-y.onrender.com/app_y/api/users");
});

test("resolve: bare key forwards root", () => {
  const r = resolveRoute(baseCfg, req({ pathname: "/app_x" }));
  assert.ok(r.ok);
  assert.equal(r.targetUrl, "https://back-x.onrender.com/");
});

test("resolve: explicit target header wins and keeps full path", () => {
  const r = resolveRoute(baseCfg, req({ pathname: "/anything/here", targetHeaderValue: "app_x" }));
  assert.ok(r.ok);
  assert.equal(r.matchedBy, "header");
  assert.equal(r.targetUrl, "https://back-x.onrender.com/anything/here");
});

test("resolve: unknown header target -> 404", () => {
  const r = resolveRoute(baseCfg, req({ targetHeaderValue: "ghost" }));
  assert.ok(!r.ok);
  assert.equal(r.status, 404);
  assert.equal(r.code, "unknown_target");
});

test("resolve: host mapping keeps full path", () => {
  const r = resolveRoute(baseCfg, req({ host: "api-x.example.com:443", pathname: "/api/users" }));
  assert.ok(r.ok);
  assert.equal(r.matchedBy, "host");
  assert.equal(r.targetUrl, "https://back-x.onrender.com/api/users");
});

test("resolve: no match -> 404 no_route", () => {
  const r = resolveRoute(baseCfg, req({ pathname: "/unknown/path" }));
  assert.ok(!r.ok);
  assert.equal(r.code, "no_route");
});

test("normalizeHost strips port and lowercases", () => {
  assert.equal(normalizeHost("API-X.Example.com:8443"), "api-x.example.com");
});

// ---------------------------------------------------------------------------
// original path recovery (rewrite handling)
// ---------------------------------------------------------------------------

test("parseOriginalPath: uses pathname when not collapsed", () => {
  const p = parseOriginalPath(new URL("https://proxy/app_x/api?a=1&__path=app_x/api"));
  assert.equal(p.pathname, "/app_x/api");
  assert.equal(p.search, "?a=1");
});

test("parseOriginalPath: falls back to __path when collapsed to function", () => {
  const p = parseOriginalPath(new URL("https://proxy/api/proxy?__path=app_x/api/users&a=1"));
  assert.equal(p.pathname, "/app_x/api/users");
  assert.equal(p.search, "?a=1");
});

test("parseOriginalPath: root", () => {
  const p = parseOriginalPath(new URL("https://proxy/api/proxy?__path="));
  assert.equal(p.pathname, "/");
  assert.equal(p.search, "");
});
