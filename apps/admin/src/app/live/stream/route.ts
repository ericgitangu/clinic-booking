// The live feed's stream, for the dashboard. The browser cannot set headers on an EventSource and
// must never hold the signing key, so this route is the admin app's backend for it: it checks the
// signed-in person and their role, signs the staff assertion for exactly this request, presents the
// admin app's own Google identity to Cloud Run (only this app and the release smoke may invoke the
// gateway), and passes the gateway's event stream through unbuffered.
//
// Vercel Hobby caps a function at 300 s (maxDuration); the gateway closes its streams at 290 s and
// the browser reconnects from the last event it saw, so a stream never meets the cap.
import { mintIdToken, minting_enabled } from "@clinic/api/proxy/gcp-id-token";
import { logError } from "@clinic/api/proxy/log";
import { buildUpstream, resumeCursor } from "@/lib/live-upstream";
import { can } from "@/lib/roles";
import { getStaff } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UPSTREAM_TIMEOUT_MS = 295_000;

function problem(status: number, code: string, headers: HeadersInit = {}) {
  return new Response(JSON.stringify({ status, code }), {
    status,
    headers: {
      "content-type": "application/problem+json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export async function GET(req: Request): Promise<Response> {
  const staff = await getStaff();
  if (!staff) return problem(401, "UNAUTHENTICATED");
  if (!staff.role || !can(staff.role, "view")) return problem(403, "FORBIDDEN");

  const base = process.env.REALTIME_URL ?? "";
  const key = process.env.INTERNAL_SIGNING_KEY ?? "";
  if (!base || !key)
    return problem(503, "REALTIME_UNAVAILABLE", { "retry-after": "60" });

  let idToken: string | null = null;
  if (minting_enabled()) {
    try {
      idToken = await mintIdToken(
        process.env.REALTIME_AUDIENCE ?? "clinic-realtime",
      );
    } catch (err) {
      logError("live feed: upstream auth failed", {
        detail: String(err).slice(0, 200),
      });
      return problem(503, "REALTIME_UNAVAILABLE", { "retry-after": "60" });
    }
  }

  const url = new URL(req.url);
  const upstream = buildUpstream({
    base,
    who: { sub: staff.sub, email: staff.email, role: staff.role },
    cursor: resumeCursor(
      url.searchParams.get("cursor"),
      req.headers.get("last-event-id"),
    ),
    signingKey: key,
    now: new Date(),
    idToken,
  });

  let res: Response;
  try {
    res = await fetch(upstream.url, {
      headers: upstream.headers,
      cache: "no-store",
      signal: AbortSignal.any([
        req.signal,
        AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      ]),
    });
  } catch {
    return problem(503, "REALTIME_UNAVAILABLE", { "retry-after": "30" });
  }

  if (!res.ok || !res.body) {
    // 429 (no free slot) and 503 reach the page as they are; anything else is a refusal.
    const status =
      res.status === 429 || res.status === 503
        ? res.status
        : res.status === 401 || res.status === 403
          ? res.status
          : 503;
    await res.body?.cancel();
    const retry = res.headers.get("retry-after") ?? "30";
    return problem(
      status,
      status === 429
        ? "RATE_LIMITED"
        : status >= 500
          ? "REALTIME_UNAVAILABLE"
          : "FORBIDDEN",
      {
        "retry-after": retry,
      },
    );
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
