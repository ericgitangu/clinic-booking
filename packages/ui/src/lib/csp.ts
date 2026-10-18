// The Content-Security-Policy both apps send on every response. One builder so the two policies
// differ only by what each app really talks to.
//
// Scripts: 'unsafe-inline' is allowed, and that is the one loose directive. Next puts inline scripts
// in every page (the hydration data, and next-themes' pre-paint theme script), so a strict policy
// needs a nonce on each response, and a nonce makes every page render per request: no static
// pages, no CDN cache, a function call per view, and a slower first paint. This project is built to
// cost nothing and to load fast, so it takes the other side of that trade: everything except inline
// script is locked down, and inline script is the open door. The real fix, if the budget changes,
// is the nonce route (proxy sets the header and the nonce; every page becomes dynamic).
// The /docs and /redoc responses add their own stricter policy (script-src 'self' only); a browser
// applies both, so those two pages stay strict.

export type CspOptions = {
  // Extra hosts, by directive.
  script?: readonly string[];
  connect?: readonly string[];
  frame?: readonly string[];
  img?: readonly string[];
  form?: readonly string[];
  // Development only: React's dev tools need eval.
  dev?: boolean;
};

// The push service (Ably). The page opens its event stream straight from the browser, to
// main.realtime.ably.net (a two-level host, so the bare realtime.ably.net entry does not cover it;
// the e2e-real job caught that). *.ably.net covers it and its siblings; the older ably.io and the
// ably-realtime.com fallback hosts stay.
export const ABLY_HOSTS = [
  "https://*.ably.net",
  "wss://*.ably.net",
  "https://rest.ably.io",
  "https://realtime.ably.net",
  "wss://realtime.ably.net",
  "https://*.ably.io",
  "wss://*.ably.io",
  "https://*.ably-realtime.com",
  "wss://*.ably-realtime.com",
] as const;

export function buildCsp(o: CspOptions = {}): string {
  const list = (...parts: (readonly string[] | undefined)[]) =>
    parts.flatMap((p) => p ?? []).join(" ");
  const directives: [string, string][] = [
    ["default-src", "'self'"],
    [
      "script-src",
      list(
        ["'self'", "'unsafe-inline'"],
        o.dev ? ["'unsafe-eval'"] : [],
        o.script,
      ),
    ],
    // Tailwind and component libraries set inline styles; styles cannot run code.
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", list(["'self'", "data:", "blob:"], o.img)],
    ["font-src", "'self' data:"],
    ["connect-src", list(["'self'"], o.dev ? ["ws:", "wss:"] : [], o.connect)],
    [
      "frame-src",
      list(
        ["'none'"].filter(() => !o.frame?.length),
        o.frame,
      ),
    ],
    ["worker-src", "'self' blob:"],
    ["manifest-src", "'self'"],
    ["media-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", list(["'self'"], o.form)],
    ["frame-ancestors", "'none'"],
  ];
  return directives.map(([k, v]) => `${k} ${v}`).join("; ");
}
