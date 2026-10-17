// Signed cookie values: base64url(payload) + "." + base64url(HMAC-SHA256(secret, payload)).
// A value that was not produced with this secret, or was altered afterwards, does not verify.
import { createHmac, timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 32;

export function secretUsable(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

function mac(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function sign(payload: string, secret: string): string {
  if (!secretUsable(secret))
    throw new Error("cookie secret is missing or too short");
  const body = Buffer.from(payload, "utf8").toString("base64url");
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

// Returns the payload, or null for anything that does not verify (including no secret).
export function verify(
  value: string,
  secret: string | undefined,
): string | null {
  if (!secretUsable(secret)) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot !== value.lastIndexOf(".")) return null;
  const body = value.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(value.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const want = mac(body, secret);
  if (given.length !== want.length || !timingSafeEqual(given, want))
    return null;
  try {
    return Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
}
