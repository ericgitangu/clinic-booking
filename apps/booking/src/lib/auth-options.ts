import { AUTH_BASE_PATH } from "@/lib/auth-config";

export interface AuthSecrets {
  baseURL: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
}

type Env = Record<string, string | undefined>;

// Better Auth's own limiter, written down instead of left to its defaults.
//
// Production: on, in memory, 100 requests per 10 seconds per client address and path (Better Auth's
// default, now explicit), with its built-in stricter rules for the sign-in and sign-up paths left in
// place. Each real visitor has an address of their own, so the limit only ever stops a flood.
//
// Test runs: the same limiter with a ceiling no test reaches. The browser tests run many workers
// from ONE address, and every page load asks for the session, so the suite itself passed 100 a
// second and the session menu then got 429 and never appeared. The relaxed value applies only when
// the app was started for tests (E2E=1 or NODE_ENV=test) and never when VERCEL_ENV is production.
export function rateLimitFor(env: Env) {
  const testRun =
    env.VERCEL_ENV !== "production" &&
    (env.NODE_ENV === "test" || env.E2E === "1");
  return {
    enabled: true,
    window: 10,
    max: testRun ? 100_000 : 100,
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
