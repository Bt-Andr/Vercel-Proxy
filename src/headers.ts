/**
 * Header hygiene for proxying.
 *
 * Hop-by-hop headers (RFC 7230 §6.1) are meaningful only for a single
 * transport-level connection and must not be forwarded by a proxy. We also
 * drop the inbound Host (set per upstream by fetch) and Vercel/infra headers
 * that would confuse the backend or leak internals.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers that must not reach the upstream. */
const STRIP_REQUEST = new Set([
  ...HOP_BY_HOP,
  "host",
  "content-length", // recomputed by fetch from the body
  "x-proxy-target", // our control headers (also configurable; see below)
  "x-proxy-key",
]);

/** Response headers that must not be passed back to the client verbatim. */
const STRIP_RESPONSE = new Set([
  ...HOP_BY_HOP,
  "content-encoding", // body is already decoded by fetch
  "content-length", // length changes once decoded; let the platform set it
]);

/**
 * Build the headers sent to the upstream backend.
 *
 * @param incoming      the original request headers
 * @param targetHeader  the configured control header name to also strip
 * @param forwardedHost the original client-facing host (for X-Forwarded-Host)
 * @param forwardedProto original protocol (http/https)
 * @param clientIp      original client IP, if known
 */
export function buildUpstreamHeaders(
  incoming: Headers,
  targetHeader: string,
  forwardedHost: string,
  forwardedProto: string,
  clientIp?: string,
): Headers {
  const out = new Headers();
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (STRIP_REQUEST.has(lower)) return;
    if (lower === targetHeader) return;
    out.set(name, value);
  });

  // Standard forwarding hints so backends can reconstruct the public origin.
  if (forwardedHost) out.set("x-forwarded-host", forwardedHost);
  if (forwardedProto) out.set("x-forwarded-proto", forwardedProto);
  if (clientIp) {
    const existing = incoming.get("x-forwarded-for");
    out.set("x-forwarded-for", existing ? `${existing}, ${clientIp}` : clientIp);
  }
  return out;
}

/** Build the headers returned to the client from the upstream response. */
export function buildDownstreamHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, name) => {
    if (STRIP_RESPONSE.has(name.toLowerCase())) return;
    out.set(name, value);
  });
  return out;
}
