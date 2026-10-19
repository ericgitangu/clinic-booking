// The real stack the end-to-end tests run against: the admin app built for production, the real
// FastAPI service and the real Postgres (docker compose). Nothing here is a stand-in.
//
// The one stand-in is Google's own sign-in (an external service on the network): see test-auth.ts.
import { signAssertion } from "@clinic/api/assertion";

// The same port the Playwright config serves the build on.
export const BASE_URL = `http://localhost:${process.env.ADMIN_E2E_PORT ?? 3101}`;

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The end-to-end tests need the compose stack: see the e2e target in the Makefile.`,
    );
  }
  return value;
}

export const API = need("E2E_API_URL").replace(/\/+$/, "");
export const SIGNING_KEY = need("INTERNAL_SIGNING_KEY");
export const AUTH_SECRET = need("BETTER_AUTH_SECRET");
export const OWNER = need("ADMIN_EMAILS").split(",")[0].trim().toLowerCase();

export type Persona = "owner" | "admin" | "viewer" | "revoked" | "stranger";

// Stable addresses, so a re-run finds the rows the last run left in the database.
export const EMAIL: Record<Persona, string> = {
  owner: OWNER,
  admin: "e2e-admin@clinic.example",
  viewer: "e2e-viewer@clinic.example",
  revoked: "e2e-revoked@clinic.example",
  stranger: "e2e-stranger@clinic.example",
};

export interface Reply<T = unknown> {
  status: number;
  body: T;
}

async function send<T>(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Reply<T>> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(text ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: text || undefined,
    cache: "no-store",
  });
  const raw = await resp.text();
  return { status: resp.status, body: (raw ? JSON.parse(raw) : null) as T };
}

/** A call to /internal/* with a real signed assertion for the given person and claimed role. */
export function internal<T = unknown>(
  method: string,
  path: string,
  who: { email: string; role: string },
  body?: unknown,
): Promise<Reply<T>> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const assertion = signAssertion(
    {
      sub: `e2e-${who.email}`,
      email: who.email,
      role: who.role,
      emailVerified: true,
      method,
      path,
      body: text,
      now: new Date(),
    },
    SIGNING_KEY,
  );
  return send<T>(method, path, body, { "X-Internal-Assertion": assertion });
}

/** A call to the public API, which has no authentication. */
export function publicApi<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  return send<T>(method, path, body, {});
}
