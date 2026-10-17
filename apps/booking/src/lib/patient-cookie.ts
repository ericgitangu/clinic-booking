import { cookies } from "next/headers";
import { secretUsable, sign, verify } from "@/lib/cookie-sign";

// Until Google sign-in lands, the browser that booked remembers who booked. The cookie holds the
// patient's id and the name to greet them with, signed with CLINIC_COOKIE_SECRET (server only), so
// a value the server did not issue is ignored. It is httpOnly. It is not bound to a server session:
// someone who copies the whole cookie from a browser can use it until it expires, which is why
// sign-in replaces it.
const NAME = "clinic_patient";
const MAX_AGE = 60 * 60 * 24 * 180;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RememberedPatient = { id: string; name: string };

export function cookieConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return secretUsable(env.CLINIC_COOKIE_SECRET);
}

export async function readPatient(): Promise<RememberedPatient | null> {
  const raw = (await cookies()).get(NAME)?.value;
  if (!raw) return null;
  const payload = verify(raw, process.env.CLINIC_COOKIE_SECRET);
  if (payload === null) return null;
  try {
    const v = JSON.parse(payload) as Partial<RememberedPatient>;
    if (
      typeof v.id === "string" &&
      UUID.test(v.id) &&
      typeof v.name === "string"
    ) {
      return { id: v.id, name: v.name.slice(0, 200) };
    }
  } catch {
    // a damaged cookie is treated as none
  }
  return null;
}

export async function rememberPatient(p: RememberedPatient): Promise<void> {
  const secret = process.env.CLINIC_COOKIE_SECRET;
  if (!secretUsable(secret)) throw new Error("CLINIC_COOKIE_SECRET is not set");
  (await cookies()).set(NAME, sign(JSON.stringify(p), secret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function forgetPatient(): Promise<void> {
  (await cookies()).delete(NAME);
}
