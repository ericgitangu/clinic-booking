// The proxy. /api/* -> Cloud Run (IAM-gated); /api/stream -> realtime. The only route
// under src/app/api/ (route-layout.test enforces this).
import { forward, problem, resolveUpstream } from "@clinic/api/proxy/forward";
import {
  TokenMintError,
  mintIdToken,
  minting_enabled,
} from "@clinic/api/proxy/gcp-id-token";
import { logError } from "@clinic/api/proxy/log";
import { checkRateLimit } from "@clinic/api/proxy/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel sets x-vercel-forwarded-for with the real client IP. If a client-supplied list ever
// reaches us, the right-most entry is the one appended by the nearest trusted proxy; the
// left-most is attacker-controlled and would let one client dodge the limiter.
function clientIp(req: Request): string | null {
  for (const name of ["x-vercel-forwarded-for", "x-forwarded-for"]) {
    const value = req.headers.get(name);
    if (value) {
      const last = value.split(",").at(-1)?.trim();
      if (last) return last;
    }
  }
  return null; // not behind Vercel's edge: rate-limited as an untrusted client, not a shared one
}

async function handler(
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path = [] } = await ctx.params;
  const upstream = resolveUpstream(path);
  if (upstream.kind === "notfound") {
    return problem(404, "NOT_FOUND", "Not found");
  }
  if (upstream.kind === "redirect") {
    return Response.redirect(new URL(upstream.to, req.url), 308);
  }
  const ip = clientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return new Response(JSON.stringify({ status: 429, code: "RATE_LIMITED" }), {
      status: 429,
      headers: {
        "content-type": "application/problem+json",
        "retry-after": String(rl.retryAfter),
      },
    });
  }
  let token: string | null = null;
  if (minting_enabled()) {
    try {
      token = await mintIdToken(upstream.audience);
    } catch (err) {
      // The first live deploy depends on this exact path (Vercel OIDC -> STS -> generateIdToken).
      // Log which stage failed and with what status so it is diagnosable from `vercel logs`.
      if (err instanceof TokenMintError) {
        logError("upstream auth failed", {
          stage: err.stage,
          status: err.status,
          detail: err.detail,
        });
      } else {
        logError("upstream auth failed", {
          stage: "unknown",
          detail: String(err).slice(0, 200),
        });
      }
      return problem(
        502,
        "UPSTREAM_AUTH_FAILED",
        "Could not authenticate to the API",
      );
    }
  }
  return forward(req, {
    baseUrl: upstream.baseUrl,
    upstreamPath: upstream.upstreamPath,
    token,
    clientIp: ip,
    timeoutMs: upstream.timeoutMs,
  });
}

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PATCH = handler;
export const OPTIONS = handler;
