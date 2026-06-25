/**
 * Self-contained end-to-end demo — no Vercel, no Upstash, no VPN required.
 *
 * Boots two fake "Render" backends + the proxy, then drives real HTTP requests
 * through it (path routing, POST body, live route added via the admin API).
 *
 *   node --import tsx scripts/demo.mjs
 */

import http from "node:http";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", r));
const fakeBackend = (name) =>
  http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-backend": name });
    res.end(JSON.stringify({ backend: name, path: req.url, method: req.method }));
  });

const hr = (t) => console.log(`\n\x1b[36m── ${t} ─────────────────────────────────────────\x1b[0m`);
async function call(method, path, opts = {}) {
  const res = await fetch(`${base}${path}`, { method, ...opts });
  const body = await res.text();
  const tag = res.ok ? "\x1b[32m" : "\x1b[31m";
  console.log(`${tag}${method} ${path}\x1b[0m  →  ${res.status}  ${body}`);
  return { res, body };
}

// 1. Two fake backends standing in for x.onrender.com / y.onrender.com
const bx = fakeBackend("BACK_X");
const by = fakeBackend("BACK_Y");
await listen(bx);
await listen(by);
const bxUrl = `http://127.0.0.1:${bx.address().port}`;
const byUrl = `http://127.0.0.1:${by.address().port}`;

// 2. Configure + start the proxy (memory store, admin enabled)
process.env.PROXY_ROUTES = JSON.stringify({ x: bxUrl, y: byUrl });
process.env.ADMIN_KEY = "demo-token";
const PORT = 3100;
const { startServer } = await import("../src/local-server.ts");
const server = startServer(PORT);
const base = `http://127.0.0.1:${PORT}`;
await new Promise((r) => setTimeout(r, 150));

console.log(`\n  BACK_X = ${bxUrl}\n  BACK_Y = ${byUrl}`);

hr("Health");
await call("GET", "/__proxy/health");

hr("Path-prefix routing (the core feature)");
await call("GET", "/x/api/hello"); // → BACK_X, path /api/hello (prefix stripped)
await call("GET", "/y/api/orders"); // → BACK_Y

hr("POST with body is forwarded");
await call("POST", "/x/submit", {
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ hello: "world" }),
});

hr("Unknown app key → 404");
await call("GET", "/unknown/thing");

hr("Admin API requires the token");
await call("GET", "/__proxy/admin/routes"); // 401 (no token)
const auth = { headers: { authorization: "Bearer demo-token" } };
await call("GET", "/__proxy/admin/routes", auth);

hr("Add a NEW destination at runtime (no restart) and use it immediately");
await call("POST", "/__proxy/admin/routes", {
  headers: { authorization: "Bearer demo-token", "content-type": "application/json" },
  body: JSON.stringify({ key: "z", target: byUrl }),
});
await call("GET", "/z/ping"); // works right away → BACK_Y

console.log("\n\x1b[32m✔ Demo complete.\x1b[0m Admin UI would be at " + base + "/__admin\n");

// Drop keep-alive sockets and let the loop drain before exiting cleanly.
server.closeAllConnections?.();
server.close();
bx.close();
by.close();
setTimeout(() => process.exit(0), 150);
