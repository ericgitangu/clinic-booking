import "server-only";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { readAuthEnv } from "@clinic/api/auth-env";
import { authOptions } from "@/lib/auth-options";
import { identityPlugins } from "@/lib/auth-plugins";

// Built on first use so that `next build` does not need the secrets.
function create() {
  const read = readAuthEnv();
  // proxy.ts answers 503 before any route gets here; this is the backstop, and it names variables only.
  if (!read.ok)
    throw new Error(`sign-in is not configured: ${read.missing.join(", ")}`);
  const env = read.env;
  return betterAuth({
    ...authOptions({
      baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    }),
    // nextCookies stays last, as Better Auth asks.
    plugins: [...identityPlugins(), nextCookies()],
  });
}

let instance: ReturnType<typeof create> | undefined;

export function getAuth() {
  instance ??= create();
  return instance;
}
