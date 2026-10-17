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

// Only these upstream response headers reach the browser. Copying the rest would leak the
// *.run.app origin and platform headers (set-cookie, server, x-cloud-trace-context,
// www-authenticate, the API's CORS headers) through the public domain. content-encoding and
// content-length are excluded on purpose: Node fetch has already decompressed the body.
const FORWARDED_RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "location",
  "retry-after",
  "x-request-id",
  "server-timing",
  "idempotent-replayed",
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
//
// Next decodes the catch-all parameter once. A '%' that is still present therefore means the
// client double-encoded something ("%252e%252e" arrives as "%2e%2e"), and the URL parser used
// by fetch would decode it again into a real ".." and collapse it, so the path we classified
// (and rate-limited, and picked an audience for) would not be the path Cloud Run receives.
// None of this API's path segments (UUIDs, slugs) contains a '%'.
function isSafeSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  return !/[/\\?#%\u0000-\u001f\u007f]/.test(segment);
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

// The URL actually requested must keep the host and the exact path that was classified. Any
// difference (a dot segment the parser collapsed, an authority change) is refused.
export function buildTarget(
  baseUrl: string,
  upstreamPath: string,
  search: string,
): URL | null {
  try {
    const base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/$/, "");
    const target = new URL(base.origin + basePath + upstreamPath + search);
    if (
      target.origin !== base.origin ||
      target.pathname !== basePath + upstreamPath
    )
      return null;
    return target;
  } catch {
    return null;
  }
}

// A Location from the API is root-relative ("/appointments/x") or, if some layer made it
// absolute, points at the upstream origin. Either way the browser must stay on /api.
export function rewriteLocation(location: string, baseUrl: string): string {
  if (location.startsWith("/")) return "/api" + location;
  try {
    const base = new URL(baseUrl);
    const abs = new URL(location);
    if (abs.origin === base.origin) {
      const basePath = base.pathname.replace(/\/$/, "");
      const rest = abs.pathname.startsWith(basePath)
        ? abs.pathname.slice(basePath.length)
        : abs.pathname;
      return "/api" + rest + abs.search + abs.hash;
    }
  } catch {
    // not an absolute URL: leave it as it was
  }
  return location;
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
  const target = buildTarget(
    opts.baseUrl,
    opts.upstreamPath,
    new URL(req.url).search,
  );
  if (!target) {
    return problem(404, "NOT_FOUND", "Not found");
  }

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
    upstream = await doFetch(target.toString(), init);
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
    if (FORWARDED_RESPONSE_HEADERS.has(key)) responseHeaders.set(key, value);
  });
  const location = upstream.headers.get("location");
  if (location) {
    responseHeaders.set("location", rewriteLocation(location, opts.baseUrl));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
