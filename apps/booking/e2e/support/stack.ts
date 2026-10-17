// The real stack the end-to-end tests run against: this app built for production, the real
// FastAPI service and the real Postgres (docker compose). Nothing here is a stand-in; the one
// stand-in is Google's own sign-in, see auth.ts.
export const BASE_URL = "http://localhost:3100";

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The end-to-end tests need the compose stack: run them with \`make e2e\`.`,
    );
  }
  return value;
}

export const API = (process.env.E2E_API_URL ?? "http://127.0.0.1:8080").replace(
  /\/+$/,
  "",
);
export const AUTH_SECRET = need("BETTER_AUTH_SECRET");
