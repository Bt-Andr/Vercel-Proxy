import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { handleProxy } from "../src/proxy.js";
import { resetConfigCache } from "../src/store.js";

const TOKEN = "admin-token";
let server: http.Server;
let baseUrl: string;

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: req.url, method: req.method }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  delete process.env.PROXY_ROUTES;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.ADMIN_KEY = TOKEN;
  resetConfigCache();
});

function adminReq(method: string, path: string, body?: unknown, token = TOKEN): Request {
  return new Request("https://proxy.example" + path, {
    method,
    headers: {
      host: "proxy.example",
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("admin disabled when ADMIN_KEY unset", async () => {
  delete process.env.ADMIN_KEY;
  resetConfigCache();
  const res = await handleProxy(adminReq("GET", "/__proxy/admin/routes"));
  assert.equal(res.status, 403);
});

test("serves the admin UI page", async () => {
  const res = await handleProxy(new Request("https://proxy.example/__admin"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /Proxy Admin/);
});

test("rejects API calls without a valid token", async () => {
  const res = await handleProxy(adminReq("GET", "/__proxy/admin/routes", undefined, "wrong"));
  assert.equal(res.status, 401);
});

test("CRUD lifecycle + live proxying of a newly added route", async () => {
  // Initially empty.
  let res = await handleProxy(adminReq("GET", "/__proxy/admin/routes"));
  let data = (await res.json()) as { routes: unknown[] };
  assert.equal(data.routes.length, 0);

  // Create.
  res = await handleProxy(
    adminReq("POST", "/__proxy/admin/routes", { key: "app_x", target: baseUrl }),
  );
  assert.equal(res.status, 200);

  // It is now listed...
  res = await handleProxy(adminReq("GET", "/__proxy/admin/routes"));
  data = (await res.json()) as { routes: { key: string }[] };
  assert.equal(data.routes.length, 1);
  assert.equal((data.routes[0] as { key: string }).key, "app_x");

  // ...and immediately proxies (cache was invalidated).
  const proxied = await handleProxy(
    new Request("https://proxy.example/app_x/ping", { headers: { host: "proxy.example" } }),
  );
  assert.equal(proxied.status, 200);
  assert.equal(((await proxied.json()) as { url: string }).url, "/ping");

  // Delete.
  res = await handleProxy(adminReq("DELETE", "/__proxy/admin/routes/app_x"));
  assert.equal(res.status, 200);

  // Gone -> proxying now 404s.
  const after = await handleProxy(
    new Request("https://proxy.example/app_x/ping", { headers: { host: "proxy.example" } }),
  );
  assert.equal(after.status, 404);
});

test("rejects an invalid target", async () => {
  const res = await handleProxy(
    adminReq("POST", "/__proxy/admin/routes", { key: "bad", target: "not-a-url" }),
  );
  assert.equal(res.status, 400);
});

test("rejects an invalid key", async () => {
  const res = await handleProxy(
    adminReq("POST", "/__proxy/admin/routes", { key: "has spaces", target: baseUrl }),
  );
  assert.equal(res.status, 400);
});

test("test endpoint probes a backend", async () => {
  await handleProxy(adminReq("POST", "/__proxy/admin/routes", { key: "app_x", target: baseUrl }));
  const res = await handleProxy(adminReq("POST", "/__proxy/admin/test", { key: "app_x" }));
  const data = (await res.json()) as { ok: boolean; status: number };
  assert.equal(data.ok, true);
  assert.equal(data.status, 200);
});
