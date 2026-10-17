import { AUTH_BASE_PATH } from "@/lib/auth-config";

export interface AuthSecrets {
  baseURL: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
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
    account: {
      storeStateStrategy: "cookie" as const,
      storeAccountCookie: true,
    },
  };
}
