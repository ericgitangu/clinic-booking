// Sessions for the end-to-end tests, made by Better Auth itself.
//
// What is stood in for: Google's OAuth endpoints, which are on the public network and cannot be
// part of a repeatable run. Everything after Google has answered is real. This builds a second
// Better Auth instance from the very same options as the app (authOptions) plus Better Auth's
// documented test plugin, https://www.better-auth.com/docs/plugins/test-utils , which creates the
// user a verified Google sign-in would have produced and logs it in. The session cookies it
// returns are signed and encrypted with the same BETTER_AUTH_SECRET, so the running app decodes
// them through its real cookie path, and then looks the role up in the real API.
//
// Better Auth's `login` returns only the signed session token cookie. The app keeps no auth
// database, so it reads the session from the encrypted cookie cache; that cookie is what
// `getSession` on the same instance sets, so both are taken from Better Auth and handed over.
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { authOptions } from "../../src/lib/auth-options";
import { AUTH_SECRET, BASE_URL } from "./stack";

const auth = betterAuth({
  ...authOptions({
    baseURL: BASE_URL,
    secret: AUTH_SECRET,
    googleClientId: randomUUID(),
    googleClientSecret: randomUUID(),
  }),
  plugins: [testUtils()],
});

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
  expires: number;
}

export async function sessionCookies(email: string): Promise<Cookie[]> {
  const { test } = await auth.$context;
  const user = test.createUser({
    email,
    name: email.split("@")[0],
    emailVerified: true,
  });
  await test.saveUser(user);
  const { headers } = await test.login({ userId: user.id });
  const cached = await auth.api.getSession({ headers, returnHeaders: true });
  if (!cached.response?.session)
    throw new Error(`Better Auth gave no session for ${email}`);
  const dataCookie = cached.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("better-auth.session_data="));
  if (!dataCookie)
    throw new Error("Better Auth did not set the session cache cookie");
  const token = headers.get("cookie")?.split(";")[0] ?? "";
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
  return [token, dataCookie].map((pair) => {
    const i = pair.indexOf("=");
    return {
      name: pair.slice(0, i),
      value: pair.slice(i + 1),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax" as const,
      expires,
    };
  });
}
