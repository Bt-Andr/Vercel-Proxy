/**
 * Vercel Function entrypoint.
 *
 * Uses the Web "fetch" signature, which runs on the Node.js runtime (the
 * recommended runtime — Edge is deprecated) and supports streaming request and
 * response bodies. All paths are routed here via the rewrite in vercel.json.
 */

import { handleProxy } from "../src/proxy";

export default {
  fetch(request: Request): Promise<Response> {
    return handleProxy(request);
  },
};
