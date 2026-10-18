// The request the admin app makes to the live-feed gateway on a signed-in person's behalf: the
// target (with the resume cursor, if it is well formed), and the signed assertion bound to exactly
// that target. Pure, so it can be tested without a session or a network.
import { ASSERTION_HEADER, signAssertion } from "@clinic/api/assertion";

const CURSOR = /^(0|[1-9][0-9]{0,19})\.(0|[1-9][0-9]{0,19})$/;

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
  signingKey: string;
  now: Date;
  idToken: string | null;
}): UpstreamRequest {
  const target = opts.cursor ? `/stream?cursor=${opts.cursor}` : "/stream";
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
