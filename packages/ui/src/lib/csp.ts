// The Content-Security-Policy both apps send, from one builder so the two policies differ only by what
// each app really talks to.
//
// Scripts have two modes:
// - "nonce": a fresh nonce per request plus 'strict-dynamic'. Only the page's own scripts (which Next
//   tags with the nonce) and scripts those load may run; an injected inline script is refused. The
//   inline theme script next-themes writes cannot carry the nonce from a static layout, so it is
//   allowed by its hash instead (THEME_SCRIPT_HASH, checked by a unit test). This needs the page to
//   render per request, so it is used for every dynamic route (all of admin, and booking's /, /book*
//   and /appointments*). reCAPTCHA is loaded by our own script, so 'strict-dynamic' covers it and no
//   Google host is named in script-src.
// - "hashes": 'self' plus the sha256 of each inline script in the page. For pages built once and
//   served from cache (booking's /about, /data, /privacy, /terms and the 404 page), which have no
//   per-request moment to mint a nonce. The hashes are read out of the built HTML by
//   apps/booking/scripts/csp-hashes.mjs after `next build`, which writes them into the build's
//   header list; the build fails if a page's hashes cannot be filled in. An injected inline script
//   is refused on those pages too.
// - "inline" ('unsafe-inline') exists only for `next dev`, where pages change on every edit.
// /docs and /redoc send their own stricter policy (script-src 'self', default-src 'none') from their
// route handlers and are left out of this one, so that a header set here cannot replace theirs.

// sha256 of THEME_INIT_SCRIPT (theme-init.ts), the one inline script every page carries: it sets the
// dark class before first paint. A nonce cannot reach it from a layout shared with pages built once,
// so it is allowed by hash. A unit test hashes the script and fails if this stops matching.
export const THEME_SCRIPT_HASH =
  "sha256-wIssp+gy6KkTqUJevBRKvpyLMTK/73krR871bDBsbOs=";

export type ScriptPolicy =
  | { kind: "nonce"; nonce: string }
  | { kind: "hashes"; hashes: readonly string[] }
  | { kind: "inline" };

export type CspOptions = {
  script: ScriptPolicy;
  connect?: readonly string[];
  frame?: readonly string[];
  img?: readonly string[];
  form?: readonly string[];
  // Development only: React's dev tools need eval, and the dev server uses websockets.
  dev?: boolean;
  // Rewrite http:// subresources to https:// in the browser. Not sent in development.
  upgradeInsecure?: boolean;
};

// The push service (Ably). The page opens its event stream straight from the browser to this one
// host, over HTTPS (server-sent events). There is no WebSocket and no SDK with fallback hosts, so
// nothing else is allowed. If the client ever changes, this entry must change with it.
export const ABLY_STREAM_ORIGIN = "https://main.realtime.ably.net";

// A fresh, unguessable value for one response. Web Crypto, so it runs in the proxy.
export function newNonce(): string {
  return btoa(crypto.randomUUID());
}

export function buildCsp(o: CspOptions): string {
  const list = (...parts: (readonly string[] | undefined)[]) =>
    parts.flatMap((p) => p ?? []).join(" ");
  const script =
    o.script.kind === "nonce"
      ? list(
          [
            `'nonce-${o.script.nonce}'`,
            `'${THEME_SCRIPT_HASH}'`,
            "'strict-dynamic'",
          ],
          o.dev ? ["'unsafe-eval'"] : [],
        )
      : o.script.kind === "hashes"
        ? list(["'self'"], o.script.hashes, o.dev ? ["'unsafe-eval'"] : [])
        : list(["'self'", "'unsafe-inline'"], o.dev ? ["'unsafe-eval'"] : []);
  const directives: [string, string][] = [
    ["default-src", "'self'"],
    ["script-src", script],
    // Tailwind and component libraries set inline styles; styles cannot run code.
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", list(["'self'", "data:", "blob:"], o.img)],
    ["font-src", "'self' data:"],
    ["connect-src", list(["'self'"], o.dev ? ["ws:", "wss:"] : [], o.connect)],
    ["frame-src", o.frame?.length ? list(o.frame) : "'none'"],
    ["worker-src", "'self' blob:"],
    ["manifest-src", "'self'"],
    ["media-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", list(["'self'"], o.form)],
    ["frame-ancestors", "'none'"],
  ];
  if (o.upgradeInsecure && !o.dev)
    directives.push(["upgrade-insecure-requests", ""]);
  return directives.map(([k, v]) => (v ? `${k} ${v}` : k)).join("; ");
}

// Headers every response carries besides the policy. Vercel already sends Strict-Transport-Security
// (max-age=63072000, observed with curl -I on both sites), so it is not repeated here.
// Not sent, and why: no report-uri/report-to, because a $0 place to collect reports does not exist in
// this project (a function that receives them costs invocations, a third-party sink costs money).
// Violations are caught in e2e instead. Named debt: nobody is told when a real user's browser blocks
// something in production.
export const SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];
