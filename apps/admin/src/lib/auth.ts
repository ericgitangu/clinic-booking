import "server-only";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { authOptions } from "@/lib/auth-options";
import { identityPlugins } from "@/lib/auth-plugins";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Built on first use so that `next build` does not need the secrets.
function create() {
  return betterAuth({
    ...authOptions({
      baseURL: need("BETTER_AUTH_URL"),
      secret: need("BETTER_AUTH_SECRET"),
      googleClientId: need("GOOGLE_CLIENT_ID"),
      googleClientSecret: need("GOOGLE_CLIENT_SECRET"),
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
