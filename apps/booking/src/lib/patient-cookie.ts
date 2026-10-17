import { cookies } from "next/headers";

// Until Google sign-in lands, the browser that booked remembers who booked. The cookie holds the
// patient's id (a random UUID, so it works as an unguessable link to their appointments) and the
// name to greet them with. It is httpOnly and not signed: anyone who copies the id sees that
// patient's appointments, which is why sign-in replaces it.
const NAME = "clinic_patient";
const MAX_AGE = 60 * 60 * 24 * 180;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RememberedPatient = { id: string; name: string };

export async function readPatient(): Promise<RememberedPatient | null> {
  const raw = (await cookies()).get(NAME)?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RememberedPatient>;
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
  (await cookies()).set(NAME, JSON.stringify(p), {
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
