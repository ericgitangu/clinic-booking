// The proxy. /api/* -> Cloud Run (IAM-gated); /api/stream -> realtime (S1). The only route
// under src/app/api/ (route-layout.test enforces this). ADR-0023, §12.4.
import { forward, resolveUpstream } from "@/lib/proxy/forward";
import { mintIdToken, minting_enabled } from "@/lib/proxy/gcp-id-token";
import { checkRateLimit } from "@/lib/proxy/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function clientIp(req: Request): string {
  // WP-00 (f): Vercel sets x-vercel-forwarded-for with the real client IP.
  const vercel = req.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0].trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "0.0.0.0";
}

async function handler(
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path = [] } = await ctx.params;
  const upstream = resolveUpstream(path);
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
  const token = minting_enabled() ? await mintIdToken(upstream.audience) : null;
  return forward(req, {
    baseUrl: upstream.baseUrl,
    upstreamPath: upstream.upstreamPath,
    token,
    clientIp: ip,
  });
}

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PATCH = handler;
export const OPTIONS = handler;
