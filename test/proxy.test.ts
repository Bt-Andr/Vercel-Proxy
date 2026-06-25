import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { handleProxy } from "../src/proxy";
import { resetConfigCache } from "../src/store";

// A tiny echo backend that reports what it received.
let server: http.Server;
let baseUrl: string;

interface EchoBody {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

before(async () => {
  server = http.createServer((reqMsg, res) => {
    const chunks: Buffer[] = [];
    reqMsg.on("data", (c) => chunks.push(c as Buffer));
    reqMsg.on("end", () => {
      // Special routes to exercise proxy behaviour.
      if (reqMsg.url === "/redirect") {
        res.writeHead(302, { location: "/somewhere" });
        res.end();
        return;
      }
      const payload: EchoBody = {
        method: reqMsg.method ?? "",
        url: reqMsg.url ?? "",
        headers: reqMsg.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(200, { "content-type": "application/json", "x-backend": "echo" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  process.env.PROXY_ROUTES = JSON.stringify({
    app_x: { target: baseUrl, hosts: ["api-x.example.com"] },
    app_y: { target: baseUrl, stripPrefix: false },
  });
  delete process.env.PROXY_GLOBAL_KEY;
  delete process.env.PROXY_ALLOWED_ORIGINS;
  delete process.env.ADMIN_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  resetConfigCache();
});

test("forwards GET with prefix stripped", async () => {
  const res = await handleProxy(
    new Request("https://proxy.example/app_x/api/users?page=2", {
      headers: { host: "proxy.example" },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-proxy-target"), "app_x");
  assert.equal(res.headers.get("x-backend"), "echo"); // upstream header passed through
  const body = (await res.json()) as EchoBody;
  assert.equal(body.method, "GET");
  assert.equal(body.url, "/api/users?page=2");
});

test("forwards POST body and content-type", async () => {
  const res = await handleProxy(
    new Request("https://proxy.example/app_x/submit", {
      method: "POST",
      headers: { "content-type": "application/json", host: "proxy.example" },
      body: JSON.stringify({ hello: "world" }),
    }),
  );
  const body = (await res.json()) as EchoBody;
  assert.equal(body.method, "POST");
  assert.equal(body.url, "/submit");
  assert.equal(body.body, JSON.stringify({ hello: "world" }));
  assert.equal(body.headers["content-type"], "application/json");
});

test("header routing keeps full path", async () => {
  const res = await handleProxy(
    new Request("https://proxy.example/anything", {
      headers: { "x-proxy-target": "app_x", host: "proxy.example" },
    }),
  );
  const body = (await res.json()) as EchoBody;
  assert.equal(body.url, "/anything");
  // control header must not leak to the backend
  assert.equal(body.headers["x-proxy-target"], undefined);
});

test("host mapping resolves the backend", async () => {
  const res = await handleProxy(
    new Request("https://api-x.example.com/api/things", {
      headers: { host: "api-x.example.com" },
    }),
  );
  const body = (await res.json()) as EchoBody;
  assert.equal(body.url, "/api/things");
});

test("sets forwarding headers", async () => {
  const res = await handleProxy(
    new Request("https://proxy.example/app_x/x", {
      headers: { host: "proxy.example", "x-forwarded-for": "9.9.9.9" },
    }),
  );
  const body = (await res.json()) as EchoBody;
  assert.equal(body.headers["x-forwarded-host"], "proxy.example");
  assert.ok(String(body.headers["x-forwarded-for"]).startsWith("9.9.9.9"));
});

test("redirects are forwarded, not followed", async () => {
  const res = await handleProxy(
    new Request("https://proxy.example/app_x/redirect", {
      headers: { host: "proxy.example" },
      redirect: "manual",
    }),
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/somewhere");
});

test("handles the collapsed rewrite form (/api/proxy?__path=...)", async () => {
  // Simulates Vercel folding the visible URL onto the function path.
  const res = await handleProxy(
    new Request("https://proxy.example/api/proxy?__path=app_x/api/users&page=2", {
      headers: { host: "proxy.example" },
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as EchoBody;
  assert.equal(body.url, "/api/users?page=2");
});

test("unknown route returns 404 JSON", async () => {
  const res = await handleProxy(
    new Request("https://proxy.example/nope/here", { headers: { host: "proxy.example" } }),
  );
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "no_route");
});

test("health endpoint lists routes", async () => {
  const res = await handleProxy(new Request("https://proxy.example/__proxy/health"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; routes: string[] };
  assert.equal(body.status, "ok");
  assert.deepEqual(body.routes.sort(), ["app_x", "app_y"]);
});

test("CORS preflight is answered locally", async () => {
  process.env.PROXY_ALLOWED_ORIGINS = "https://front.example";
  resetConfigCache();
  const res = await handleProxy(
    new Request("https://proxy.example/app_x/api", {
      method: "OPTIONS",
      headers: {
        origin: "https://front.example",
        "access-control-request-method": "POST",
        host: "proxy.example",
      },
    }),
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://front.example");
  assert.ok(res.headers.get("access-control-allow-methods")?.includes("POST"));
});

test("CORS headers added to proxied responses for allowed origin", async () => {
  process.env.PROXY_ALLOWED_ORIGINS = "https://front.example";
  resetConfigCache();
  const res = await handleProxy(
    new Request("https://proxy.example/app_x/api", {
      headers: { origin: "https://front.example", host: "proxy.example" },
    }),
  );
  assert.equal(res.headers.get("access-control-allow-origin"), "https://front.example");
});

test("global key gates requests", async () => {
  process.env.PROXY_GLOBAL_KEY = "topsecret";
  resetConfigCache();

  const denied = await handleProxy(
    new Request("https://proxy.example/app_x/api", { headers: { host: "proxy.example" } }),
  );
  assert.equal(denied.status, 401);

  const allowed = await handleProxy(
    new Request("https://proxy.example/app_x/api", {
      headers: { host: "proxy.example", "x-proxy-key": "topsecret" },
    }),
  );
  assert.equal(allowed.status, 200);
});

test("upstream unreachable returns 502", async () => {
  process.env.PROXY_ROUTES = JSON.stringify({ dead: "http://127.0.0.1:1" });
  process.env.PROXY_MAX_RETRIES = "0";
  resetConfigCache();
  const res = await handleProxy(
    new Request("https://proxy.example/dead/x", { headers: { host: "proxy.example" } }),
  );
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "upstream_unreachable");
});
