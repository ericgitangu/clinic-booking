// Core proxy forwarding. Pure enough to unit-test: fetch is injectable and the token is passed
// in (null locally). The route handler wires env + token minting.

// Only these client request headers reach Cloud Run. Everything else (cookie, authorization,
// x-forwarded-*, hop-by-hop headers, a spoofed x-client-ip or x-serverless-authorization) is
// dropped; the proxy adds its own x-client-ip and invoker token below.
const FORWARDED_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "accept-language",
  "x-request-id",
  "idempotency-key",
]);

// Node fetch decompresses the upstream body, so copying these would corrupt it.
const DROP_RESPONSE = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "OPTIONS"]);
const MAX_BODY_BYTES = 64 * 1024;
const API_TIMEOUT_MS = 25_000;
const STREAM_TIMEOUT_MS = 295_000;
const REDIRECT_PATHS = new Set(["/docs", "/redoc", "/openapi.json"]);

export type Upstream =
  | { kind: "redirect"; to: string }
  | { kind: "notfound" }
  | {
      kind: "proxy";
      baseUrl: string;
      audience: string;
      upstreamPath: string;
      timeoutMs: number;
    };

// A decoded catch-all segment must be a plain path component: it is joined into the upstream
// URL, so anything that could change its meaning (separators, query, fragment, dot segments,
// control characters) is rejected rather than forwarded.
function isSafeSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  // eslint-disable-next-line no-control-regex
  return !/[/\\?#\u0000-\u001f\u007f]/.test(segment);
}

export function resolveUpstream(segments: string[]): Upstream {
  if (segments.length === 0 || !segments.every(isSafeSegment)) {
    return { kind: "notfound" };
  }
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
      timeoutMs: STREAM_TIMEOUT_MS,
    };
  }
  return {
    kind: "proxy",
    baseUrl: process.env.API_URL ?? "",
    audience: process.env.API_AUDIENCE ?? "clinic-api",
    upstreamPath: joined,
    timeoutMs: API_TIMEOUT_MS,
  };
}

export function problem(
  status: number,
  code: string,
  detail: string,
): Response {
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
  timeoutMs?: number;
}

// Reads at most MAX_BODY_BYTES; the Content-Length header alone is client-controlled.
async function readCappedBody(
  req: Request,
): Promise<Uint8Array | "too-large" | null> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function forward(
  req: Request,
  opts: ForwardOptions,
): Promise<Response> {
  if (!ALLOWED_METHODS.has(req.method)) {
    return problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  }
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    return problem(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 64 KB");
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const search = new URL(req.url).search;
  const target = opts.baseUrl.replace(/\/$/, "") + opts.upstreamPath + search;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (FORWARDED_REQUEST_HEADERS.has(key)) headers.set(key, value);
  });
  if (opts.clientIp) headers.set("x-client-ip", opts.clientIp);
  if (opts.token)
    headers.set("x-serverless-authorization", `Bearer ${opts.token}`);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? API_TIMEOUT_MS),
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await readCappedBody(req);
    if (body === "too-large") {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 64 KB");
    }
    if (body) init.body = body as BodyInit;
  }

  let upstream: Response;
  try {
    upstream = await doFetch(target, init);
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      return problem(
        504,
        "UPSTREAM_TIMEOUT",
        "The API did not respond in time",
      );
    }
    return problem(502, "UPSTREAM_UNAVAILABLE", "The API could not be reached");
  }

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
