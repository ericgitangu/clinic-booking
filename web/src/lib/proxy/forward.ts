// Core proxy forwarding (ADR-0023, §12.4). Pure enough to unit-test: fetch is injectable
// and the token is passed in (null locally). The route handler wires env + token minting.

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Node fetch decompresses the upstream body, so copying these would corrupt it.
const DROP_RESPONSE = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "OPTIONS"]);
const MAX_BODY_BYTES = 64 * 1024;
const REDIRECT_PATHS = new Set(["/docs", "/redoc", "/openapi.json"]);

export type Upstream =
  | { kind: "redirect"; to: string }
  | { kind: "proxy"; baseUrl: string; audience: string; upstreamPath: string };

export function resolveUpstream(segments: string[]): Upstream {
  const joined = "/" + segments.join("/");
  if (REDIRECT_PATHS.has(joined)) {
    return { kind: "redirect", to: joined };
  }
  if (joined === "/stream") {
    return {
      kind: "proxy",
      baseUrl: process.env.REALTIME_URL ?? "",
      audience: process.env.REALTIME_AUDIENCE ?? "clinic-realtime",
      upstreamPath: "/stream",
    };
  }
  return {
    kind: "proxy",
    baseUrl: process.env.API_URL ?? "",
    audience: process.env.API_AUDIENCE ?? "clinic-api",
    upstreamPath: joined,
  };
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ status, code, detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

export interface ForwardOptions {
  baseUrl: string;
  upstreamPath: string;
  token?: string | null;
  clientIp?: string | null;
  fetchImpl?: typeof fetch;
}

export async function forward(
  req: Request,
  opts: ForwardOptions,
): Promise<Response> {
  if (!ALLOWED_METHODS.has(req.method)) {
    return problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  }
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return problem(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 64 KB");
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const search = new URL(req.url).search;
  const target = opts.baseUrl.replace(/\/$/, "") + opts.upstreamPath + search;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key)) headers.set(key, value);
  });
  // Client must never spoof the invoker token or the client IP.
  headers.delete("x-serverless-authorization");
  headers.delete("x-client-ip");
  if (opts.clientIp) headers.set("x-client-ip", opts.clientIp);
  if (opts.token)
    headers.set("x-serverless-authorization", `Bearer ${opts.token}`);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (hasBody) {
    init.body = req.body;
    init.duplex = "half";
  }

  const upstream = await doFetch(target, init);

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE.has(key)) responseHeaders.set(key, value);
  });
  const location = upstream.headers.get("location");
  if (location && location.startsWith("/")) {
    responseHeaders.set("location", "/api" + location);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
