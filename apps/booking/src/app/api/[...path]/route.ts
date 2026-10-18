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

// The live-updates token route is anonymous and cheap to call from another site's page, so a
// browser request must come from this site. The check is made here, where the Origin header is
// still visible, and Origin is passed on (for this route only) so the API can check it as well.
const TOKEN_PATH = "realtime/token/patient";

function crossSiteTokenRequest(req: Request, path: string[]): boolean {
  if (req.method !== "POST" || path.join("/") !== TOKEN_PATH) return false;
  const origin = req.headers.get("origin");
  // No Origin: not a browser (a browser always sends it on a cross-site POST); the address
  // limits still apply. A present Origin must be this site's own.
  return origin !== null && origin !== new URL(req.url).origin;
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
  if (crossSiteTokenRequest(req, path)) {
    return problem(
      403,
      "FORBIDDEN",
      "This site may not ask for a live-updates token",
    );
  }
  const ip = clientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return new Response(JSON.stringify({ status: 429, code: "RATE_LIMITED" }), {
      status: 429,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
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
    // Behind Vercel the edge always supplies the client address. Off Vercel (local development and
    // the end-to-end runs) there is none, and the browser is on this machine.
    clientIp: ip ?? (process.env.VERCEL ? null : "127.0.0.1"),
    timeoutMs: upstream.timeoutMs,
    extraRequestHeaders: path.join("/") === TOKEN_PATH ? ["origin"] : [],
  });
}

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PATCH = handler;
export const OPTIONS = handler;
