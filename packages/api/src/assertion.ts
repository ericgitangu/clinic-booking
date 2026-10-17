import { createHash, createHmac } from "node:crypto";

// The signed assertion the API requires on every /internal/* call. The wire format is fixed by
// the API (backend/app/core/assertion.py): `v1.<payload>.<mac>`, payload = base64url of the
// canonical JSON (sorted keys, no whitespace) of the claims, mac = base64url HMAC-SHA256 of the
// payload. tests/assertion.test.ts holds a header produced by the Python side for the same input.
export const ASSERTION_AUDIENCE = "clinic-api/internal";
export const ASSERTION_HEADER = "X-Internal-Assertion";
export const ASSERTION_TTL_SECONDS = 60;

export interface AssertionClaims {
  sub: string;
  email: string;
  role: string;
  method: string;
  /** Path with query string, exactly as it is sent. */
  path: string;
  body: string;
  now: Date;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function signAssertion(claims: AssertionClaims, key: string): string {
  const iat = Math.floor(claims.now.getTime() / 1000);
  const payload = Buffer.from(
    canonicalJson({
      aud: ASSERTION_AUDIENCE,
      sub: claims.sub,
      email: claims.email,
      role: claims.role,
      iat,
      exp: iat + ASSERTION_TTL_SECONDS,
      m: claims.method.toUpperCase(),
      p: claims.path,
      bh: createHash("sha256").update(claims.body, "utf8").digest("hex"),
    }),
    "utf8",
  ).toString("base64url");
  const mac = createHmac("sha256", key).update(payload).digest("base64url");
  return `v1.${payload}.${mac}`;
}
