import { AUTH_BASE_PATH } from "@/lib/auth-config";
import { isTestRun } from "@/lib/test-run";

export interface AuthSecrets {
  baseURL: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
}

type Env = Record<string, string | undefined>;

// Better Auth's own limiter, with its numbers written down.
//
// Better Auth turns the limiter on in production builds (and off under `next dev`), 100 requests
// per 10 seconds per client address and path, in memory, plus stricter built-in rules for the
// sign-in and sign-up paths. This keeps all of that: `enabled` is NOT set, so the library default
// still applies, and the numbers are the library's own. A visitor's address comes from the
// X-Forwarded-For header; with no usable header every request shares one bucket (UNVERIFIED how
// Vercel shapes that header in production, so do not read this as per-visitor isolation).
//
// Test runs: the browser tests run many workers from ONE address, and every page load asks for the
// session, so the suite itself could pass 100 reads in 10 seconds and the session menu then got
// 429. The ceiling is lifted only for a test run (see lib/test-run.ts: not Vercel production,
// E2E=1 or NODE_ENV=test, and a local base URL).
export function rateLimitFor(env: Env) {
  return {
    window: 10,
    max: isTestRun(env) ? 100_000 : 100,
    storage: "memory" as const,
  };
}

// The one definition of how sessions work. The running app uses it as it is; the end-to-end tests
// build a second instance from the same options (plus Better Auth's test plugin) so the cookies
// they mint are produced by exactly this configuration and read back by the real app.
//
// Stateless: no database, the session lives in a signed and encrypted cookie. A session cannot be
// revoked early, which is why who may do what is looked up on every request (see session.ts) and
// never read from the cookie.
export function authOptions(s: AuthSecrets) {
  return {
    baseURL: s.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: s.secret,
    socialProviders: {
      google: {
        clientId: s.googleClientId,
        clientSecret: s.googleClientSecret,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60 * 24 * 7,
        strategy: "jwe" as const,
        refreshCache: true,
      },
    },
    rateLimit: rateLimitFor(process.env),
    account: {
      storeStateStrategy: "cookie" as const,
      storeAccountCookie: true,
    },
  };
}
