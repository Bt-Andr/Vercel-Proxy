/**
 * Local HTTP server adapter.
 *
 * Wraps the platform-agnostic `handleProxy` (Web fetch handler) in a Node
 * http.Server so the proxy can run anywhere — `npm start`, a VM, Docker — not
 * just on Vercel. Streams request and response bodies both ways.
 */

import http from "node:http";
import { Readable } from "node:stream";
import { handleProxy } from "./proxy.js";

type WebRequestInit = RequestInit & { duplex?: "half" };

/** Convert a Node IncomingMessage into a WHATWG Request. */
function toWebRequest(req: http.IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  const url = `${proto}://${host}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: WebRequestInit = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as ReadableStream;
    init.duplex = "half";
  }
  return new Request(url, init);
}

/** Pipe a WHATWG Response back into a Node ServerResponse. */
async function writeWebResponse(res: http.ServerResponse, web: Response): Promise<void> {
  const headers: Record<string, string> = {};
  web.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(web.status, web.statusText || undefined, headers);

  if (web.body) {
    Readable.fromWeb(web.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } else {
    res.end();
  }
}

export function startServer(port = Number(process.env.PORT) || 3000): http.Server {
  const server = http.createServer((req, res) => {
    handleProxy(toWebRequest(req))
      .then((web) => writeWebResponse(res, web))
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "proxy_crash", message: String(err) }));
      });
  });
  server.listen(port, () => {
    console.log(`▶ Proxy listening on http://localhost:${port}`);
    console.log(`  health: http://localhost:${port}/__proxy/health`);
    if (process.env.ADMIN_KEY) console.log(`  admin:  http://localhost:${port}/__admin`);
  });
  return server;
}

// Run directly: `node --import tsx src/local-server.ts`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("local-server.ts")) {
  startServer();
}
