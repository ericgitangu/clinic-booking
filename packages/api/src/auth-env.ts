import { z } from "zod";

// The one definition of what sign-in needs from the environment, shared by both web apps. It is
// read per request (never at build, so `next build` needs no secrets) and a gap is answered with a
// 503 page instead of a crash: see the proxy.ts of each app.
const set = z.string().trim().min(1);

export const authEnvSchema = z.object({
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_SECRET: set,
  GOOGLE_CLIENT_ID: set,
  GOOGLE_CLIENT_SECRET: set,
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

export type AuthEnvResult =
  { ok: true; env: AuthEnv } | { ok: false; missing: string[] };

type Source = Record<string, string | undefined>;

/** Names only: a value, valid or not, never leaves this function. */
export function readAuthEnv(source: Source = process.env): AuthEnvResult {
  const parsed = authEnvSchema.safeParse(source);
  if (parsed.success) return { ok: true, env: parsed.data };
  const names = parsed.error.issues.map((i) => String(i.path[0]));
  return { ok: false, missing: [...new Set(names)] };
}

let logged = false;

/** One structured line per server instance, so a broken deploy shows once rather than on every hit. */
export function logNotConfiguredOnce(app: string, missing: string[]): void {
  if (logged) return;
  logged = true;
  console.error(
    JSON.stringify({
      level: "error",
      event: "auth_not_configured",
      app,
      missing,
    }),
  );
}

export function resetNotConfiguredLog(): void {
  logged = false;
}

/** The page every route answers with while sign-in is not configured. Self-contained: no env, no session, no API. */
export function notConfiguredResponse(name: string): Response {
  const title = "Sign-in is not configured";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · ${name}</title>
<style>
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1c1b1a;--muted:#5d5a56}
@media (prefers-color-scheme:dark){:root{--bg:#161514;--fg:#f0eeeb;--muted:#a8a39d}}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:18px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:34rem;padding:2rem 1rem}
h1{font-size:1.75rem;line-height:1.25;margin:0 0 1rem}
p{margin:0 0 .75rem;color:var(--muted)}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${name} cannot sign anyone in right now because its settings are not finished. Nothing is wrong with your account.</p>
<p>Please try again in a little while. If this keeps happening, tell the clinic's site owner.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "300",
      "x-robots-tag": "noindex",
    },
  });
}
