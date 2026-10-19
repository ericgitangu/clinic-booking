// The request the admin app makes to the live-feed gateway on a signed-in person's behalf: the
// target (with the resume cursor and the appointment filter, when well formed), the signed
// assertion bound to exactly that target, and how the gateway's answer is passed on. Pure or
// fetch-injected, so it can be tested without a session or a network.
import { ASSERTION_HEADER, signAssertion } from "@clinic/api/assertion";

const CURSOR = /^(0|[1-9][0-9]{0,19})\.(0|[1-9][0-9]{0,19})$/;
// The same strict form the gateway accepts: one canonical lower-case UUID.
const APPOINTMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The cursor to resume from: the query parameter, else Last-Event-ID, and only if well formed. */
export function resumeCursor(
  param: string | null,
  lastEventId: string | null,
): string | null {
  for (const c of [param, lastEventId]) {
    if (c && CURSOR.test(c)) return c;
  }
  return null;
}

/** The appointment filter: absent is null, present must be a canonical UUID (else "invalid"). */
export function appointmentFilter(
  param: string | null,
): string | null | "invalid" {
  if (param === null) return null;
  return APPOINTMENT.test(param) ? param : "invalid";
}

export interface Who {
  sub: string;
  email: string;
  role: string;
}

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
}

export function buildUpstream(opts: {
  base: string;
  who: Who;
  cursor: string | null;
  appointment?: string | null;
  signingKey: string;
  now: Date;
  idToken: string | null;
}): UpstreamRequest {
  const query = new URLSearchParams();
  if (opts.appointment) query.set("appointment", opts.appointment);
  if (opts.cursor) query.set("cursor", opts.cursor);
  const qs = query.toString();
  const target = qs ? `/stream?${qs}` : "/stream";
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    [ASSERTION_HEADER]: signAssertion(
      {
        sub: opts.who.sub,
        email: opts.who.email,
        role: opts.who.role,
        emailVerified: true,
        method: "GET",
        path: target,
        body: "",
        now: opts.now,
      },
      opts.signingKey,
    ),
  };
  if (opts.idToken)
    headers["x-serverless-authorization"] = `Bearer ${opts.idToken}`;
  return { url: opts.base.replace(/\/+$/, "") + target, headers };
}

/**
 * Cloud Run, not the gateway, answers a client when every instance is busy (concurrency 1, at most
 * two instances): the request waits in its queue and may never get response headers. The admin
 * app gives up after this long and tells the page the feed is busy, so it falls back to refreshing
 * instead of showing "connecting" forever.
 */
export const HEADER_TIMEOUT_MS = 10_000;

export type UpstreamProblem = {
  status: number;
  code: string;
  retryAfter: string;
};

/**
 * What the page gets for a refused stream. 429 (no free slot, the gateway's or Cloud Run's) and
 * "no headers in time" are RATE_LIMITED, the page's busy fallback; 503 is unavailable (also the
 * fallback); 401/403 are a refusal; 422 (a cursor or filter the gateway will not take) becomes 400
 * so the page drops its cursor and starts fresh instead of retrying the same one; anything else
 * is unavailable.
 */
export function mapUpstreamStatus(
  status: number,
  retryAfter: string | null,
): UpstreamProblem {
  const retry = retryAfter ?? "30";
  if (status === 429)
    return { status: 429, code: "RATE_LIMITED", retryAfter: retry };
  if (status === 401 || status === 403)
    return { status, code: "FORBIDDEN", retryAfter: retry };
  if (status === 422 || status === 400)
    return { status: 400, code: "VALIDATION_ERROR", retryAfter: "0" };
  return { status: 503, code: "REALTIME_UNAVAILABLE", retryAfter: retry };
}

export type UpstreamResult =
  | { kind: "stream"; body: ReadableStream<Uint8Array> }
  | { kind: "problem"; problem: UpstreamProblem }
  | { kind: "aborted" };

/**
 * Open the upstream stream. The header wait is bounded by headerTimeoutMs (a busy Cloud Run);
 * once headers arrive only the caller's signal and the overall lifetime bound the body.
 */
export async function openUpstream(opts: {
  req: UpstreamRequest;
  signal: AbortSignal;
  lifetimeMs: number;
  headerTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<UpstreamResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (opts.signal.aborted) return { kind: "aborted" };
  opts.signal.addEventListener("abort", onAbort, { once: true });
  let headersTimedOut = false;
  const headerTimer = setTimeout(() => {
    headersTimedOut = true;
    ctl.abort();
  }, opts.headerTimeoutMs ?? HEADER_TIMEOUT_MS);
  const lifetime = setTimeout(() => ctl.abort(), opts.lifetimeMs);
  // The lifetime timer must not keep a test runner or a finished function alive.
  (lifetime as { unref?: () => void }).unref?.();
  let res: Response;
  try {
    res = await doFetch(opts.req.url, {
      headers: opts.req.headers,
      cache: "no-store",
      signal: ctl.signal,
    });
  } catch {
    clearTimeout(headerTimer);
    clearTimeout(lifetime);
    opts.signal.removeEventListener("abort", onAbort);
    if (headersTimedOut)
      return {
        kind: "problem",
        problem: { status: 429, code: "RATE_LIMITED", retryAfter: "30" },
      };
    if (opts.signal.aborted) return { kind: "aborted" };
    return {
      kind: "problem",
      problem: { status: 503, code: "REALTIME_UNAVAILABLE", retryAfter: "30" },
    };
  }
  clearTimeout(headerTimer);
  if (!res.ok || !res.body) {
    clearTimeout(lifetime);
    opts.signal.removeEventListener("abort", onAbort);
    await res.body?.cancel();
    return {
      kind: "problem",
      problem: mapUpstreamStatus(res.status, res.headers.get("retry-after")),
    };
  }
  return { kind: "stream", body: res.body };
}
