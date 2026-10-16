// The proxy. /api/* -> Cloud Run (IAM-gated); /api/stream -> realtime. The only route
// under src/app/api/ (route-layout.test enforces this).
import { forward, problem, resolveUpstream } from "@/lib/proxy/forward";
import { mintIdToken, minting_enabled } from "@/lib/proxy/gcp-id-token";
import { checkRateLimit } from "@/lib/proxy/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel sets x-vercel-forwarded-for with the real client IP. If a client-supplied list ever
// reaches us, the right-most entry is the one appended by the nearest trusted proxy; the
// left-most is attacker-controlled and would let one client dodge the limiter.
function clientIp(req: Request): string {
  for (const name of ["x-vercel-forwarded-for", "x-forwarded-for"]) {
    const value = req.headers.get(name);
    if (value) {
      const last = value.split(",").at(-1)?.trim();
      if (last) return last;
    }
  }
  return "0.0.0.0";
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
    } catch {
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
