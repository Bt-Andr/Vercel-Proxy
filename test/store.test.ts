import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { MemoryStore, UpstashStore, resolveConfig, resetConfigCache } from "../src/store";
import type { RouteRecord } from "../src/types";

function route(key: string, target: string): RouteRecord {
  return { key, target, stripPrefix: true };
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

test("MemoryStore: seed, put, list, remove", async () => {
  const store = new MemoryStore([route("a", "https://a.test")]);
  assert.equal((await store.list()).length, 1);
  await store.put(route("b", "https://b.test"));
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.remove("a"), true);
  assert.equal(await store.remove("missing"), false);
  const keys = (await store.list()).map((r) => r.key);
  assert.deepEqual(keys, ["b"]);
});

// ---------------------------------------------------------------------------
// UpstashStore against a fake Upstash REST server
// ---------------------------------------------------------------------------

let server: http.Server;
let url: string;
let hash: Map<string, string>;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer test-token") {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const cmd = JSON.parse(Buffer.concat(chunks).toString()) as (string | number)[];
      const op = String(cmd[0]).toUpperCase();
      let result: unknown = null;
      if (op === "HGETALL") {
        const flat: string[] = [];
        for (const [k, v] of hash) flat.push(k, v);
        result = flat;
      } else if (op === "HSET") {
        for (let i = 2; i + 1 < cmd.length; i += 2) hash.set(String(cmd[i]), String(cmd[i + 1]));
        result = 1;
      } else if (op === "HDEL") {
        result = hash.delete(String(cmd[2])) ? 1 : 0;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  hash = new Map();
});

test("UpstashStore: put/list/remove round-trip", async () => {
  const store = new UpstashStore(url, "test-token");
  await store.put(route("app_x", "https://x.onrender.com"));
  await store.put(route("app_y", "https://y.onrender.com"));
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((r) => r.key === "app_x")?.target, "https://x.onrender.com");
  assert.equal(await store.remove("app_x"), true);
  assert.equal((await store.list()).length, 1);
});

test("UpstashStore: seeds an empty store from env once", async () => {
  const store = new UpstashStore(url, "test-token", [route("seed", "https://seed.test")]);
  const first = await store.list(); // empty -> seeds
  assert.equal(first.length, 1);
  assert.equal(hash.size, 1); // written through to the backend
});

test("UpstashStore: bad token surfaces an error", async () => {
  const store = new UpstashStore(url, "wrong");
  await assert.rejects(() => store.list());
});

// ---------------------------------------------------------------------------
// resolveConfig backend selection
// ---------------------------------------------------------------------------

test("resolveConfig: picks Upstash when env is present", async () => {
  process.env.UPSTASH_REDIS_REST_URL = url;
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  process.env.PROXY_ROUTES = JSON.stringify({ app_z: "https://z.onrender.com" });
  resetConfigCache();
  const cfg = await resolveConfig();
  assert.equal(cfg.storage, "upstash");
  assert.equal(cfg.routes.get("app_z")?.target, "https://z.onrender.com"); // seeded
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  resetConfigCache();
});

test("resolveConfig: falls back to memory without Upstash env", async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.PROXY_ROUTES = JSON.stringify({ app_m: "https://m.onrender.com" });
  resetConfigCache();
  const cfg = await resolveConfig();
  assert.equal(cfg.storage, "memory");
  assert.equal(cfg.routes.get("app_m")?.target, "https://m.onrender.com");
});

test("resolveConfig: disabled routes are not served", async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.PROXY_ROUTES = JSON.stringify({
    on: "https://on.test",
    off: { target: "https://off.test", disabled: true },
  });
  resetConfigCache();
  const cfg = await resolveConfig();
  assert.ok(cfg.routes.has("on"));
  assert.ok(!cfg.routes.has("off"));
});
