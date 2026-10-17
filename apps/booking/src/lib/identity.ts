// What a session says about the person, and the name to give their patient record. Pure, so the
// rules are tested without a server.

export interface Identity {
  /** Google's own subject for the person: stable across devices, instances and sign-ins. */
  sub: string;
  email: string;
  /** What to call them on screen. */
  name: string;
}

interface SessionLike {
  user?: {
    email?: string | null;
    emailVerified?: boolean;
    name?: string | null;
  } | null;
  googleSub?: string | null;
}

// An identity needs Google's subject (never Better Auth's own user id, which is made up per
// instance) and an address Google has verified. Anything less is not someone we act on.
export function identityFrom(
  session: SessionLike | null | undefined,
): Identity | null {
  const user = session?.user;
  const sub = session?.googleSub;
  if (!sub || !user?.email || !user.emailVerified) return null;
  const email = user.email.toLowerCase();
  return { sub, email, name: user.name?.trim() || email };
}

const MIN_NAME = 2;
const MAX_NAME = 200;

// The API wants a full name of 2 to 200 characters. A Google display name can be one letter or very
// long, and that must never stop someone booking: fall back to the part of the email before the @,
// then pad.
export function patientName(who: Pick<Identity, "name" | "email">): string {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const name = clean(who.name);
  if (name.length >= MIN_NAME) return name.slice(0, MAX_NAME);
  const local = clean(who.email.split("@")[0] ?? "");
  if (local.length >= MIN_NAME) return local.slice(0, MAX_NAME);
  return `${name || local || "Patient"} .`.slice(0, MAX_NAME);
}
